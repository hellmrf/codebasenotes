import * as vscode from 'vscode';
import * as path from 'path';
import * as fsSync from 'fs';
import { GitignoreParser } from './gitignoreUtils';

interface AnnotationNode {
    type: string;
    annotation?: string;
    subNodes: Map<string, AnnotationNode>;
}

export class AnnotationEditorProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'annotationEditor';
    private _view?: vscode.WebviewView;
    private currentEditingItem: string | undefined;
    private annotations: AnnotationNode = { type: 'dir', subNodes: new Map() };
    private annotationFilePath: string;
    private annotationDir: string;
    private annotationFileName: string;
    private vscodeConfig: vscode.WorkspaceConfiguration;
    private gitignoreParser: GitignoreParser;
    private fileSystemWatcher: vscode.FileSystemWatcher;
    private annotationsExist: boolean = true;
    private currentElements: Set<string> = new Set();
    private lastEditAnnotationTime: number = 0;
    private incrementingId: number = 0;

    private _onDidChangeAnnotation = new vscode.EventEmitter<string>();
    public readonly onDidChangeAnnotation = this._onDidChangeAnnotation.event;


    constructor(private readonly _extensionUri: vscode.Uri, private workspaceRoot: string) {
        // Load User Config
        this.vscodeConfig = vscode.workspace.getConfiguration('codebaseNotes');
        this.annotationDir = path.join(this.workspaceRoot, this.vscodeConfig.get("path", ".vscode"));
        this.annotationFileName = this.vscodeConfig.get('filename', '.codebasenotes-annotations.json');
        this.annotationFilePath = path.join(this.annotationDir, this.annotationFileName);

        this.gitignoreParser = new GitignoreParser(workspaceRoot);
        this.fileSystemWatcher = this.createFileSystemWatcher();
        this.loadAnnotations();
    }

    private createFileSystemWatcher(): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.annotationDir, this.annotationFileName)
        );
        watcher.onDidDelete(() => this.handleAnnotationFileDeleted());
        watcher.onDidCreate(() => this.loadAnnotations());
        return watcher;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        this.setupWebviewMessageListener(webviewView);
    }

    private setupWebviewMessageListener(webviewView: vscode.WebviewView) {
        webviewView.webview.onDidReceiveMessage(data => {
            if (data.type === 'annotationUpdated') {
                this.updateAnnotation(data.value);
            }
        });
    }

    public async editAnnotation(element: string) {
        const relativePath = path.relative(this.workspaceRoot, element);
        if (this.gitignoreParser.isIgnored(relativePath)) {
            vscode.window.showInformationMessage('This file/folder is ignored by .gitignore and cannot be edited.');
            return;
        }

        if (!this._view) {
            await this.ensureWebviewInitialized();
        }

        if (this._view) {
            this.currentEditingItem = element;
            this._view.show?.(true);

            if (!this.currentElements.has(element)) {
                await this.openReferencedFiles(element);
                this.scheduleClearCurrentElements();
            }
            await this._view.webview.postMessage({
                type: 'setAnnotation',
                itemName: path.basename(element),
                annotation: this.getAnnotation(element)
            });
            this.incrementingId++;
        } else {
            vscode.window.showErrorMessage('Unable to open annotation editor. Please try again.');
        }
    }

    private scheduleClearCurrentElements() {
        setTimeout(() => {
            this.currentElements.clear();
        }, 3000);
    }

    private async openReferencedFiles(element: string) {
        const annotation = this.getAnnotation(element);
        const regex = /\s*\[\s*([^\]]+)\s*\]\s*/g;
        let match;
        const filesToOpen = new Set<string>();

        while ((match = regex.exec(annotation)) !== null) {
            const relativePath = match[1].trim().replace(/\\/g, '/');
            const fullPath = path.join(this.workspaceRoot, relativePath);

            try {
                if (await this.fileExists(fullPath)) {
                    const stat = fsSync.statSync(fullPath);
                    if (stat.isFile()) {
                        filesToOpen.add(fullPath);
                        this.currentElements.add(fullPath);
                    }
                }
            } catch (error) {
                console.error(`Error processing file: ${relativePath}`, error);
            }
        }

        if (filesToOpen.size > 0) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            filesToOpen.add(element);
            this.currentElements.add(element);
        }

        for (const file of filesToOpen) {
            try {
                const document = await vscode.workspace.openTextDocument(file);
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (error) {
                console.error(`Error opening file: ${file}`, error);
            }
        }
    }

    private updateAnnotation(annotation: string) {
        if (this.currentEditingItem) {
            const relativePath = path.relative(this.workspaceRoot, this.currentEditingItem);
            if (!this.gitignoreParser.isIgnored(relativePath)) {
                this.setAnnotation(relativePath, annotation);
                this.saveAnnotations();
                this._onDidChangeAnnotation.fire(this.currentEditingItem);
            }
        }
    }

    public getAnnotation(element: string): string {
        if (!this.annotationsExist) return '';
        const relativePath = path.relative(this.workspaceRoot, element);
        if (this.gitignoreParser.isIgnored(relativePath)) return '';
        return this.getAnnotationFromNode(this.annotations, relativePath.split(path.sep));
    }

    private getAnnotationFromNode(node: AnnotationNode, parts: string[]): string {
        if (parts.length === 0) return node.annotation || '';
        const nextNode = node.subNodes.get(parts[0]);
        return nextNode ? this.getAnnotationFromNode(nextNode, parts.slice(1)) : '';
    }

    private setAnnotation(relativePath: string, annotation: string) {
        this.annotationsExist = true;
        if (this.gitignoreParser.isIgnored(relativePath)) return;
        const parts = relativePath.split(path.sep);
        let node = this.annotations;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!node.subNodes.has(part)) {
                const fullPath = path.join(this.workspaceRoot, ...parts.slice(0, i + 1));
                const type = this.getNodeType(fullPath, i === parts.length - 1);
                node.subNodes.set(part, { type, subNodes: new Map() });
            }
            node = node.subNodes.get(part)!;
        }
        node.annotation = annotation;
    }

    public removeAnnotation(path: string): void {
        const relativePath = vscode.workspace.asRelativePath(path);
        const parts = relativePath.split('/');
        let node = this.annotations;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node.subNodes.has(parts[i])) return;
            node = node.subNodes.get(parts[i])!;
        }
        node.subNodes.delete(parts[parts.length - 1]);
        this.saveAnnotations();
    }

    public moveAnnotation(oldPath: string, newPath: string): void {
        const annotation = this.getAnnotation(oldPath);
        if (annotation) {
            this.removeAnnotation(oldPath);
            this.setAnnotation(newPath, annotation);
        }
    }

    private getNodeType(fullPath: string, isFile: boolean): string {
        try {
            const stats = fsSync.statSync(fullPath);
            if (!isFile || stats.isDirectory()) return 'dir';
            const ext = path.extname(fullPath).slice(1).toLowerCase();
            return ext || 'file';
        } catch (error) {
            console.error(`Error getting node type for ${fullPath}:`, error);
            return 'file';
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'annotationEditor.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'annotationEditor.css'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet">
            <title>Annotation Editor</title>
        </head>
        <body>
            <h2 id="itemName"></h2>
            <textarea id="annotation" rows="10"></textarea>
            <script src="${scriptUri}"></script>
        </body>
        </html>`;
    }

    private loadAnnotations() {
        try {
            const data = fsSync.readFileSync(this.annotationFilePath, 'utf8');
            this.annotations = this.deserializeAnnotations(JSON.parse(data));
            this.cleanupIgnoredAnnotations(this.annotations);
            this.annotationsExist = true;
        } catch (error) {
            if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
                this.annotationsExist = false;
            } else {
                console.error('Error loading annotations:', error);
            }
        }
    }

    private saveAnnotations() {
        if (!this.annotationsExist) return;
        try {
            this.cleanupIgnoredAnnotations(this.annotations);
            const data = JSON.stringify(this.serializeAnnotations(this.annotations), null, 2);
            fsSync.writeFileSync(this.annotationFilePath, data);
        } catch (error) {
            console.error('Error saving annotations:', error);
            vscode.window.showErrorMessage(`Failed to save annotations: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private cleanupIgnoredAnnotations(node: AnnotationNode, currentPath: string = '') {
        for (const [key, childNode] of node.subNodes.entries()) {
            const childPath = path.join(currentPath, key);
            if (this.gitignoreParser.isIgnored(childPath)) {
                node.subNodes.delete(key);
            } else {
                this.cleanupIgnoredAnnotations(childNode, childPath);
                if (childNode.subNodes.size === 0 && childNode.annotation === undefined) {
                    node.subNodes.delete(key);
                }
            }
        }
    }

    private serializeAnnotations(node: AnnotationNode): any {
        const result: any = { type: node.type };
        if (node.annotation !== undefined) result.annotation = node.annotation;
        if (node.subNodes.size > 0) {
            result.subNodes = Object.fromEntries(
                Array.from(node.subNodes.entries()).map(([key, value]) => [key, this.serializeAnnotations(value)])
            );
        }
        return result;
    }

    private deserializeAnnotations(data: any): AnnotationNode {
        const node: AnnotationNode = { type: data.type, subNodes: new Map() };
        if (data.annotation !== undefined) node.annotation = data.annotation;
        if (data.subNodes) {
            for (const [key, value] of Object.entries(data.subNodes)) {
                node.subNodes.set(key, this.deserializeAnnotations(value as any));
            }
        }
        return node;
    }

    private handleAnnotationFileDeleted() {
        this.annotationsExist = false;
        this.annotations = { type: 'dir', subNodes: new Map() };
        this._onDidChangeAnnotation.fire('');
    }

    private async ensureWebviewInitialized(): Promise<void> {
            // Wait for the webview to be initialized
            return new Promise((resolve) => {
                let disposable: vscode.Disposable | undefined;

                const checkInterval = setInterval(() => {
                    if (this._view) {
                        clearInterval(checkInterval);
                        if (disposable) {
                            disposable.dispose();
                        }
                        resolve();
                    } else if (!disposable) {
                        try {
                            disposable = vscode.window.registerWebviewViewProvider(AnnotationEditorProvider.viewType, this, {
                                webviewOptions: {
                                    retainContextWhenHidden: true,
                                }
                            });
                        } catch (error) {
                            console.error('Error registering webview view provider:', error);
                            clearInterval(checkInterval);
                            resolve(); // Resolve anyway to prevent hanging
                        }
                }
            }, 200);
        });
    }

    dispose() {
        this.fileSystemWatcher.dispose();
    }

    public async createAnnotationFileIfNotExists(): Promise<void> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(this.annotationFilePath));
        } catch {
            // File doesn't exist, create it
            const initialContent = JSON.stringify({ type: 'dir', subNodes: {} }, null, 2);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(this.annotationFilePath), Buffer.from(initialContent, 'utf8'));
            this.annotationsExist = true;
            this.annotations = { type: 'dir', subNodes: new Map() };
            this._onDidChangeAnnotation.fire('');
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            return true;
        } catch {
            return false;
        }
    }
}
