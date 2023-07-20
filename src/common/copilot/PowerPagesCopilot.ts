/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 */


import * as vscode from "vscode";
import { sendApiRequest } from "./IntelligenceApiService";
import { dataverseAuthentication, intelligenceAPIAuthentication } from "../../web/client/common/authenticationProvider";
import { v4 as uuidv4 } from 'uuid'
import { PacWrapper } from "../../client/pac/PacWrapper";
import { ITelemetry } from "../../client/telemetry/ITelemetry";
import { AuthProfileNotFound, COPILOT_UNAVAILABLE, CopilotDisclaimer, CopilotStylePathSegments, DataverseEntityNameMap, EntityFieldMap, FieldTypeMap, WebViewMessage, sendIconSvg } from "./constants";
import { IActiveFileParams, IActiveFileData} from './model';
import { escapeDollarSign, getLastThreePartsOfFileName, getNonce, getUserName, showConnectedOrgMessage, showInputBoxAndGetOrgUrl } from "../Utils";
import { CESUserFeedback } from "./user-feedback/CESSurvey";
import { GetAuthProfileWatchPattern } from "../../client/lib/AuthPanelView";
import { PacActiveOrgListOutput } from "../../client/pac/PacTypes";
import { CopyCodeToClipboardEvent, InsertCodeToEditorEvent, UserFeedbackThumbsDownEvent, UserFeedbackThumbsUpEvent } from "./telemetry/telemetryConstants";
import { sendTelemetryEvent } from "./telemetry/copilotTelemetry";
import { getEntityColumns, getEntityName } from "./dataverseMetadata";
import { INTELLIGENCE_SCOPE_DEFAULT, PROVIDER_ID } from "../../web/client/common/constants";
import { getIntelligenceEndpoint } from "../ArtemisService";

let apiToken: string;
let userName: string;
let orgID: string;
let environmentName: string;
let userID: string;
let activeOrgUrl: string;
let sessionID: string;

//TODO: Check if it can be converted to singleton
export class PowerPagesCopilot implements vscode.WebviewViewProvider {
  public static readonly viewType = "powerpages.copilot";
  private _view?: vscode.WebviewView;
  private readonly _pacWrapper: PacWrapper;
  private _extensionContext: vscode.ExtensionContext;
  private readonly _disposables: vscode.Disposable[] = [];
  private loginButtonRendered = false;
  private telemetry: ITelemetry;
  private aibEndpoint: string | null = null;

  constructor(private readonly _extensionUri: vscode.Uri, _context: vscode.ExtensionContext, telemetry: ITelemetry, pacWrapper: PacWrapper) {
    this.telemetry = telemetry;
    this._extensionContext = _context;
    this._pacWrapper = pacWrapper;

    this._disposables.push(
      vscode.commands.registerCommand("powerpages.copilot.clearConversation", () => {
        if (userName && orgID) {
          this.sendMessageToWebview({ type: "clearConversation" });
          sessionID = uuidv4();
        }
      }
      )
    );
    this.setupFileWatcher();
  }


  private isDesktop: boolean = vscode.env.uiKind === vscode.UIKind.Desktop;

  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }

  private setupFileWatcher() {
    const watchPath = GetAuthProfileWatchPattern();
    if (watchPath) {
      const watcher = vscode.workspace.createFileSystemWatcher(watchPath);
      this._disposables.push(
        watcher,
        watcher.onDidChange(() => this.handleOrgChange()),
        watcher.onDidCreate(() => this.handleOrgChange()),
        watcher.onDidDelete(() => this.handleOrgChange())
      );
    }
  }

  private async handleOrgChange() {
    orgID = '';
    const pacOutput = await this._pacWrapper.activeOrg();

    if (pacOutput.Status === "Success") {
      this.handleOrgChangeSuccess(pacOutput);
    } else if (this._view?.visible) {

      const userOrgUrl = await showInputBoxAndGetOrgUrl();
      if (!userOrgUrl) {
        return;
      }
      const pacAuthCreateOutput = await this._pacWrapper.authCreateNewAuthProfileForOrg(userOrgUrl);
      if (pacAuthCreateOutput.Status !== "Success") {
        vscode.window.showErrorMessage("Failed to create auth profile for the org"); //TODO: Provide Experience to create auth profile
        return;
      }

    }
  }


  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    context: vscode.WebviewViewResolveContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.description = "PREVIEW"
    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [this._extensionUri],
    };

    const pacOutput = await this._pacWrapper.activeOrg();

    if (pacOutput.Status === "Success") { 
      this.handleOrgChangeSuccess(pacOutput);
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "webViewLoaded": {

          sessionID = uuidv4();
          this.sendMessageToWebview({ type: 'env'}); //TODO Use IS_DESKTOP
          await this.checkAuthentication();
          if(orgID && userName) {
            this.sendMessageToWebview({type: 'isLoggedIn', value: true});
            this.sendMessageToWebview({ type: 'userName', value: userName });
          }else
          {
            this.sendMessageToWebview({type: 'isLoggedIn', value: false});
            this.loginButtonRendered = true;
          }
          this.sendMessageToWebview({ type: "welcomeScreen" });
          break;
        }
        case "login": {
          this.handleLogin();
          break;
        }
        case "newUserPrompt": {
          orgID
            ? (() => {
              const { activeFileParams } = this.getActiveEditorContent();
              this.authenticateAndSendAPIRequest(data.value, activeFileParams, orgID, this.telemetry);
            })()
            : (() => {
              this.sendMessageToWebview({ type: 'apiResponse', value: AuthProfileNotFound });
              this.sendMessageToWebview({ type: 'enableInput' });
            })();

          break;
        }
        case "insertCode": {

          const escapedSnippet = escapeDollarSign(data.value);

          vscode.window.activeTextEditor?.insertSnippet(
            new vscode.SnippetString(`${escapedSnippet}`)
          );
          sendTelemetryEvent(this.telemetry, { eventName: InsertCodeToEditorEvent, copilotSessionId: sessionID });
          break;
        }
        case "copyCodeToClipboard": {

          vscode.env.clipboard.writeText(data.value);
          vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard!'))
          sendTelemetryEvent(this.telemetry, { eventName: CopyCodeToClipboardEvent, copilotSessionId: sessionID });
          break;
        }
        case "clearChat": {

          sessionID = uuidv4();
          break;
        }
        case "userFeedback": {

          if (data.value === "thumbsUp") {

            sendTelemetryEvent(this.telemetry, { eventName: UserFeedbackThumbsUpEvent, copilotSessionId: sessionID });
            CESUserFeedback(this._extensionContext, sessionID, userID, "thumbsUp", this.telemetry)
          } else if (data.value === "thumbsDown") {

            sendTelemetryEvent(this.telemetry, { eventName: UserFeedbackThumbsDownEvent, copilotSessionId: sessionID });
            CESUserFeedback(this._extensionContext, sessionID, userID, "thumbsDown", this.telemetry)
          }
        }
      }
    });
  }

  public show() {
    if (this._view) {
      // Show the webview view
      this._view.show(true);
    }
  }

  private async handleLogin() {

    const pacOutput = await this._pacWrapper.activeOrg();
    if (pacOutput.Status === "Success") {
      this.handleOrgChangeSuccess.call(this, pacOutput);

      intelligenceAPIAuthentication().then(({ accessToken, user }) => {

        this.intelligenceAPIAuthenticationHandler.call(this, accessToken, user);
      });

    } else if (this._view?.visible) {

      const userOrgUrl = await showInputBoxAndGetOrgUrl();
      if (!userOrgUrl) {
        this.sendMessageToWebview({ type: 'isLoggedIn', value: false });

        if (!this.loginButtonRendered) {
          this.sendMessageToWebview({ type: "welcomeScreen" });
          this.loginButtonRendered = true; // Set the flag to indicate that the login button has been rendered
        }

        return;
      }
      const pacAuthCreateOutput = await this._pacWrapper.authCreateNewAuthProfileForOrg(userOrgUrl);
      pacAuthCreateOutput.Status === "Success"
        ? intelligenceAPIAuthentication().then(({ accessToken, user }) =>
          this.intelligenceAPIAuthenticationHandler.call(this, accessToken, user)
        )
        : vscode.window.showErrorMessage("Error creating auth profile for org");


    }
  }

  private async checkAuthentication() {
    const session = await vscode.authentication.getSession(PROVIDER_ID, [`${INTELLIGENCE_SCOPE_DEFAULT}`], { silent: true });
    if (session) {
        apiToken = session.accessToken;
        userName = getUserName(session.account.label);
    } else {
        apiToken = "";
        userName = "";
    }
}

  private authenticateAndSendAPIRequest(data: string, activeFileParams: IActiveFileParams, orgID: string, telemetry: ITelemetry) {
    return intelligenceAPIAuthentication()
      .then(async ({ accessToken, user }) => {
        apiToken = accessToken;
        userName = getUserName(user);
        this.sendMessageToWebview({ type: 'userName', value: userName });

        let entityName = "";
        let entityColumns: string[] = [];

        if (activeFileParams.dataverseEntity == "adx_entityform" || activeFileParams.dataverseEntity == 'adx_entitylist') {
          entityName = getEntityName(telemetry, sessionID, activeFileParams.dataverseEntity);

          const dataverseToken = await dataverseAuthentication(activeOrgUrl);

          entityColumns = await getEntityColumns(entityName, activeOrgUrl, dataverseToken, telemetry, sessionID);
        }

        return sendApiRequest(data, activeFileParams, orgID, apiToken, sessionID, entityName, entityColumns, this.aibEndpoint);
      })
      .then(apiResponse => {
        this.sendMessageToWebview({ type: 'apiResponse', value: apiResponse });
        this.sendMessageToWebview({ type: 'enableInput' });
      });
  }


  private async handleOrgChangeSuccess(pacOutput: PacActiveOrgListOutput) {
    const activeOrg = pacOutput.Results;
    orgID = activeOrg.OrgId;
    environmentName = activeOrg.FriendlyName;
    userID = activeOrg.UserId;
    activeOrgUrl = activeOrg.OrgUrl;

    this.aibEndpoint = await getIntelligenceEndpoint(orgID, this.telemetry, sessionID);
    if(this.aibEndpoint === COPILOT_UNAVAILABLE) {
      this.sendMessageToWebview({ type: 'notAvailable'});
    }

    if (this._view?.visible) { 
      showConnectedOrgMessage(environmentName, activeOrgUrl);
    }
  }

  private async intelligenceAPIAuthenticationHandler(accessToken: string, user: string) {
    if (accessToken && user) {

      apiToken = accessToken;
      userName = getUserName(user);
      this.sendMessageToWebview({ type: 'isLoggedIn', value: true})
      this.sendMessageToWebview({ type: 'userName', value: userName });
      this.sendMessageToWebview({ type: "welcomeScreen" });
    }
  }



  private getActiveEditorContent(): IActiveFileData {
    const activeEditor = vscode.window.activeTextEditor;
    const activeFileData: IActiveFileData = {
      activeFileContent: '',
      activeFileParams: {
        dataverseEntity: '',
        entityField: '',
        fieldType: ''
      } as IActiveFileParams
    };
    if (activeEditor) {
      const document = activeEditor.document;
      const fileName = document.fileName;
      const relativeFileName = vscode.workspace.asRelativePath(fileName);

      const activeFileParams: string[] = getLastThreePartsOfFileName(relativeFileName);

      activeFileData.activeFileContent = document.getText();
      activeFileData.activeFileParams.dataverseEntity = DataverseEntityNameMap.get(activeFileParams[0]) || "";
      activeFileData.activeFileParams.entityField = EntityFieldMap.get(activeFileParams[1]) || "";
      activeFileData.activeFileParams.fieldType = FieldTypeMap.get(activeFileParams[2]) || "";
    }

    return activeFileData;
  }

  public sendMessageToWebview(message: WebViewMessage) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {


    const copilotScriptPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'common', 'copilot', 'assets', 'scripts', 'copilot.js');
    const copilotScriptUri = webview.asWebviewUri(copilotScriptPath);

    const copilotStylePath = vscode.Uri.joinPath(
      this._extensionUri,
      ...CopilotStylePathSegments
    );
    const copilotStyleUri = webview.asWebviewUri(copilotStylePath);

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    //TODO: Add CSP
    return `
        <!DOCTYPE html>
        <html lang="en">
        
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="${copilotStyleUri}" rel="stylesheet">
          </link>
          <title>Chat View</title>
        </head>
        
        <body>
          <div class="copilot-window">
        
            <div class="chat-messages" id="chat-messages">
              <div id="copilot-header"></div>
            </div>
        
            <div class="chat-input" id="input-component">
              <div class="input-container">
                <input type="text" placeholder="What do you need help with?" id="chat-input" class="input-field">
                <button aria-label="Match Case" id="send-button" class="send-button">
                  <span>
                    ${sendIconSvg}
                  </span>
                </button>
              </div>
              <p class="disclaimer">${CopilotDisclaimer}</p>
            </div>
          </div>
        
          <script type="module" nonce="${nonce}" src="${copilotScriptUri}"></script>
        </body>
        
        </html>`;
  }
}