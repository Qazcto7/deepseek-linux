import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'path';
import { config } from './config/index.js';
import { fileURLToPath } from 'url';
import electronContextMenu from 'electron-context-menu';
import { AgentExecutor } from './agent-executor.js';

// Linux & Chromium Stability: Prevent shared memory (/dev/shm) crashes on Linux
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

// Constants
const APP_URL = 'https://chat.deepseek.com';
const DEEPSEEK_PROTOCOL = 'deepseek://';
const ICON_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'assets/icon.png'
);

// Set up the context menu
electronContextMenu({
  showSaveImageAs: true,
});

let mainWindow = null;
const executor = new AgentExecutor();

/**
 * Clean up active child processes and resources before exit
 */
function cleanupResources() {
  try {
    executor.cleanup();
  } catch (err) {
    console.error('Executor cleanup error:', err);
  }
}

// Register IPC handlers for Linux system operations
function setupIpcHandlers() {
  ipcMain.handle('agent:run-command', async (event, command, timeout) => {
    try {
      return await executor.runCommand(
        command,
        (chunk) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('agent:command-chunk', chunk);
          }
        },
        timeout
      );
    } catch (err) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        error: err.message,
        cwd: executor.cwd,
        durationMs: 0,
      };
    }
  });

  ipcMain.handle('agent:cancel-command', async () => {
    return executor.cancelActiveCommand();
  });

  ipcMain.handle('agent:get-command-risk', async (_, command) => {
    return executor.getRiskAssessment(command);
  });

  ipcMain.handle('agent:get-cwd', async () => {
    return executor.cwd;
  });

  ipcMain.handle('agent:read-file', async (_, filePath, startLine, endLine) => {
    return await executor.readFile(filePath, startLine, endLine);
  });

  ipcMain.handle(
    'agent:write-file',
    async (_, filePath, content, append = false) => {
      return await executor.writeFile(filePath, content, append);
    }
  );

  ipcMain.handle('agent:append-file', async (_, filePath, content) => {
    return await executor.writeFile(filePath, content, true);
  });

  ipcMain.handle('agent:list-directory', async (_, dirPath) => {
    return await executor.listDirectory(dirPath);
  });

  ipcMain.handle('agent:file-info', async (_, filePath) => {
    return await executor.fileInfo(filePath);
  });

  ipcMain.handle(
    'agent:edit-file',
    async (_, filePath, target, replacement, startLine, endLine) => {
      return await executor.editFile(
        filePath,
        target,
        replacement,
        startLine,
        endLine
      );
    }
  );

  ipcMain.handle('agent:fetch-url', async (_, url) => {
    return await executor.fetchUrl(url);
  });

  ipcMain.handle('agent:get-system-info', async () => {
    return await executor.getSystemInfo();
  });
}

/**
 * Handles new window creation, specifically for Google Sign-In popups.
 * @param {Object} details - Details about the new window.
 * @returns {Object} Action to take.
 */
function handleNewWindow(details) {
  if (details.url.includes('accounts.google.com')) {
    shell.openExternal(details.url);
    return { action: 'deny' };
  }
  return { action: 'allow' };
}

/**
 * Creates the main application window with crash & memory safety handlers.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    icon: ICON_PATH,
    autoHideMenuBar: true,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nativeWindowOpen: true,
      preload: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'preload.js'
      ),
      webSecurity: true,
    },
  });

  mainWindow.loadURL(APP_URL, {
    userAgent: config.userAgent,
  });

  mainWindow.webContents.setWindowOpenHandler(handleNewWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
  });

  // Crash Prevention & Diagnostics
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process gone:', details);
    executor.cancelActiveCommand();
    if (
      details.reason !== 'clean-exit' &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      console.warn('Attempting renderer reload after crash...');
      mainWindow.reload();
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('DeepSeek window became unresponsive. Monitoring...');
  });

  // Memory Optimization: Clean session cache when minimized
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.session.clearCache().catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    cleanupResources();
    mainWindow = null;
  });
}

/**
 * Processes command line arguments to extract a valid URL.
 * @param {Array<string>} args - Command line arguments.
 * @returns {string|null} The extracted URL or null.
 */
function processCommandLineArgs(args) {
  const httpsRegex = /^https:\/\/chat\.deepseek\.com(?:[/?#].*)?$/;
  const deepseekRegex = /^deepseek:\/\//;

  for (const arg of args) {
    if (httpsRegex.test(arg)) {
      return arg;
    }
    if (deepseekRegex.test(arg)) {
      const deepseekPath = arg
        .substring(DEEPSEEK_PROTOCOL.length)
        .replace(/^\/+/, '');
      return `${APP_URL}/${deepseekPath}`;
    }
  }
  return null;
}

/**
 * Handles second instance events.
 * @param {Event} event - The event.
 * @param {Array<string>} args - Command line arguments.
 */
function handleSecondInstance(event, args) {
  if (mainWindow) {
    const url = processCommandLineArgs(args);
    if (url) {
      mainWindow.loadURL(url, { userAgent: config.userAgent });
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

/**
 * Initializes the application.
 */
async function initializeApp() {
  // Set the app name
  app.setName('DeepSeek');

  // Request single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Setup IPC Handlers
  setupIpcHandlers();

  // Child process crash diagnostics
  app.on('child-process-gone', (event, details) => {
    console.warn('Child process gone:', details);
  });

  // Graceful shutdown listeners
  app.on('before-quit', cleanupResources);
  app.on('will-quit', cleanupResources);

  process.on('SIGINT', () => {
    cleanupResources();
    app.quit();
  });
  process.on('SIGTERM', () => {
    cleanupResources();
    app.quit();
  });

  // Wait for app to be ready
  await app.whenReady();

  // Create the main window
  createMainWindow();

  // Handle second instance
  app.on('second-instance', handleSecondInstance);

  // Handle window all closed
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Handle activate (macOS)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

// Start the application
initializeApp().catch(console.error);
