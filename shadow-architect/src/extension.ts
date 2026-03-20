import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/chatViewProvider';
import { ShadowWorkspace } from './workspace/workspace';

export function activate(context: vscode.ExtensionContext) {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const shadowWorkspace = new ShadowWorkspace(context.globalStorageUri.fsPath, workspacePath);
  const provider = new ChatViewProvider(context.extensionUri, shadowWorkspace, workspacePath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.openChat', async () => {
      await vscode.commands.executeCommand('shadow-architect.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.initProject', async () => {
      const defaultName = vscode.workspace.name || 'Shadow Project';
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for this Shadow Project',
        value: defaultName,
        ignoreFocusOut: true
      });

      if (name === undefined) {
        return;
      }

      await provider.initializeCurrentWorkspaceAsShadowProject(name);
      await vscode.window.showInformationMessage(`Shadow Project initialized: ${name.trim() || defaultName}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.listProjects', async () => {
      const projects = await shadowWorkspace.listRegisteredProjects();
      if (projects.length === 0) {
        await vscode.window.showInformationMessage('No registered Shadow Projects yet.');
        return;
      }

      const picks = projects.map(project => ({
        label: project.name,
        description: project.path,
        detail: `Last used: ${new Date(project.lastUsedAt).toLocaleString()}`,
        id: project.id
      }));

      await vscode.window.showQuickPick(picks, {
        placeHolder: 'Registered Shadow Projects'
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.deleteProject', async () => {
      const projects = await shadowWorkspace.listRegisteredProjects();
      if (projects.length === 0) {
        await vscode.window.showInformationMessage('No registered Shadow Projects to delete.');
        return;
      }

      const picks = projects.map(project => ({
        label: project.name,
        description: project.path,
        detail: `Project ID: ${project.id}`,
        id: project.id
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a Shadow Project to delete'
      });

      if (!selected) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete Shadow Project data for ${selected.label}?`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') {
        return;
      }

      const deleted = await shadowWorkspace.deleteRegisteredProject(selected.id);
      if (deleted) {
        await provider.refreshRegistrationState();
        await vscode.window.showInformationMessage(`Deleted Shadow Project data for ${selected.label}.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.openProject', async () => {
      const projects = await shadowWorkspace.listRegisteredProjects();
      if (projects.length === 0) {
        await vscode.window.showInformationMessage('No registered Shadow Projects to open.');
        return;
      }

      const picks = projects.map(project => ({
        label: project.name,
        description: project.path,
        detail: `Project ID: ${project.id}`,
        path: project.path
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a Shadow Project to open'
      });

      if (!selected) {
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(selected.path),
        { forceNewWindow: true }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.remember', async () => {
      const isRegistered = await shadowWorkspace.isRegistered();
      if (!isRegistered) {
        await vscode.window.showInformationMessage('Initialize this workspace as a Shadow Project first.');
        return;
      }

      const input = await vscode.window.showInputBox({
        prompt: 'Add a persistent project decision',
        ignoreFocusOut: true
      });

      if (!input || !input.trim()) {
        return;
      }

      await shadowWorkspace.addDecision(input.trim());
      await vscode.window.showInformationMessage('Saved project decision.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadow-architect.recall', async () => {
      const isRegistered = await shadowWorkspace.isRegistered();
      if (!isRegistered) {
        await vscode.window.showInformationMessage('Initialize this workspace as a Shadow Project first.');
        return;
      }

      const prompt = await shadowWorkspace.buildContextPrompt();
      await vscode.window.showInformationMessage(prompt, { modal: true });
    })
  );

}

export function deactivate() {}
