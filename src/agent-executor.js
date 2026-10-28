import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

const BLACKLISTED_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/,
  /rm\s+-rf\s+\/\*/,
  /mkfs/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /dd\s+if=.*of=\/dev\/[shv]d[a-z]/,
  />\s*\/dev\/sd[a-z]/,
  /chmod\s+(-R\s+)?777\s+\//,
];

const PROTECTED_SYSTEM_PATHS = [
  '/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/dev',
  '/proc',
  '/sys',
  '/var',
];

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.mp3',
  '.wav',
  '.flac',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.iso',
  '.pdf',
  '.exe',
  '.bin',
  '.so',
  '.dll',
  '.dylib',
  '.pyc',
  '.class',
  '.o',
  '.a',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

const SAFE_COMMANDS = new Set([
  'ls',
  'dir',
  'pwd',
  'whoami',
  'id',
  'uname',
  'date',
  'uptime',
  'cat',
  'head',
  'tail',
  'more',
  'less',
  'grep',
  'egrep',
  'fgrep',
  'find',
  'locate',
  'which',
  'whereis',
  'type',
  'file',
  'stat',
  'df',
  'du',
  'free',
  'top',
  'htop',
  'ps',
  'pstree',
  'git status',
  'git log',
  'git diff',
  'git branch',
  'git show',
  'echo',
  'printf',
  'wc',
  'sort',
  'uniq',
  'diff',
  'cmp',
]);

const HIGH_RISK_KEYWORDS = [
  'rm ',
  'rmdir',
  'kill',
  'pkill',
  'killall',
  'dd ',
  'fdisk',
  'parted',
  'chmod',
  'chown',
  'systemctl',
  'reboot',
  'shutdown',
  'poweroff',
  'mkfs',
  'iptables',
  'ufw',
  'pacman -R',
  'apt remove',
  'apt purge',
];

export class AgentExecutor {
  constructor() {
    this.homeDir = os.homedir();
    this.cwd = this.homeDir;
    this.backupDir = path.join(
      this.homeDir,
      '.config',
      'deepseek-linux',
      'backups'
    );
    this.activeChildProcess = null;
    this.history = [];
    this.MAX_HISTORY = 50;
    this.MAX_BACKUPS = 30;
  }

  getEnv() {
    const userLocalBin = path.join(this.homeDir, '.local', 'bin');
    const userCargoBin = path.join(this.homeDir, '.cargo', 'bin');
    const currentPath = process.env.PATH || '';

    const paths = currentPath.split(':');
    if (!paths.includes(userLocalBin)) paths.unshift(userLocalBin);
    if (!paths.includes(userCargoBin)) paths.unshift(userCargoBin);

    return {
      ...process.env,
      PATH: paths.join(':'),
      HOME: this.homeDir,
      TERM: 'xterm-256color',
    };
  }

  resolvePath(filePath) {
    if (!filePath) return '';
    let resolved = String(filePath).trim();

    if (
      (resolved.startsWith('"') && resolved.endsWith('"')) ||
      (resolved.startsWith("'") && resolved.endsWith("'"))
    ) {
      resolved = resolved.slice(1, -1).trim();
    }

    if (resolved.startsWith('$HOME')) {
      resolved = path.join(this.homeDir, resolved.slice(5));
    } else if (resolved.startsWith('${HOME}')) {
      resolved = path.join(this.homeDir, resolved.slice(7));
    }

    if (resolved.startsWith('~/')) {
      resolved = path.join(this.homeDir, resolved.slice(2));
    } else if (resolved === '~') {
      resolved = this.homeDir;
    } else if (!path.isAbsolute(resolved)) {
      resolved = path.join(this.cwd, resolved);
    }

    if (resolved.includes('/Desktop/') || resolved.endsWith('/Desktop')) {
      const masaustuDir = path.join(this.homeDir, 'Masaüstü');
      resolved = resolved.replace(
        path.join(this.homeDir, 'Desktop'),
        masaustuDir
      );
    }

    return path.resolve(resolved);
  }

  isProtectedPath(resolvedPath) {
    for (const sysPath of PROTECTED_SYSTEM_PATHS) {
      if (resolvedPath === sysPath || resolvedPath.startsWith(sysPath + '/')) {
        return true;
      }
    }
    const sshDir = path.join(this.homeDir, '.ssh');
    if (resolvedPath.startsWith(sshDir)) {
      return true;
    }
    return false;
  }

  isDangerous(cmd) {
    const trimmed = (cmd || '').trim();
    return BLACKLISTED_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  getRiskAssessment(command) {
    const trimmed = (command || '').trim();
    if (this.isDangerous(trimmed)) {
      return {
        level: 'blocked',
        label: 'Engellendi (Tehlikeli)',
        color: '#ef4444',
      };
    }

    for (const kw of HIGH_RISK_KEYWORDS) {
      if (trimmed.includes(kw)) {
        return {
          level: 'high',
          label: 'Yüksek Risk (Sistem/Silme)',
          color: '#f87171',
        };
      }
    }

    const firstWord = trimmed.split(/\s+/)[0];
    const firstTwoWords = trimmed.split(/\s+/).slice(0, 2).join(' ');

    if (SAFE_COMMANDS.has(firstWord) || SAFE_COMMANDS.has(firstTwoWords)) {
      if (
        !trimmed.includes('>') &&
        !trimmed.includes('| rm') &&
        !trimmed.includes('| bash')
      ) {
        return { level: 'safe', label: 'Güvenli (Okuma)', color: '#4ade80' };
      }
    }

    return {
      level: 'moderate',
      label: 'Normal Sistem İşlemi',
      color: '#fbbf24',
    };
  }

  async getSystemInfo() {
    return {
      username: os.userInfo().username,
      homeDir: this.homeDir,
      cwd: this.cwd,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      desktop: process.env.XDG_CURRENT_DESKTOP || 'KDE',
    };
  }

  /**
   * Kills any active child process and its entire process tree (zombie prevention)
   */
  cancelActiveCommand() {
    if (this.activeChildProcess && this.activeChildProcess.pid) {
      try {
        const pid = this.activeChildProcess.pid;
        this.activeChildProcess = null;
        // Kill process group to prevent orphaned grandchildren
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (_) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (_) {}
        }
        return {
          success: true,
          message: 'Komut ve bağlı alt süreçler başarıyla sonlandırıldı.',
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    return { success: false, error: 'Aktif çalışan bir komut yok.' };
  }

  cleanup() {
    this.cancelActiveCommand();
  }

  /**
   * Prunes backup files to prevent disk bloating
   */
  async pruneBackups(maxKeep = this.MAX_BACKUPS) {
    try {
      const files = await fs.readdir(this.backupDir);
      if (files.length <= maxKeep) return;

      const fileStats = await Promise.all(
        files.map(async (f) => {
          const p = path.join(this.backupDir, f);
          const stat = await fs.stat(p).catch(() => null);
          return { name: f, path: p, mtime: stat ? stat.mtimeMs : 0 };
        })
      );

      const validFiles = fileStats.filter((f) => f.mtime > 0);
      validFiles.sort((a, b) => b.mtime - a.mtime); // newest first

      const toDelete = validFiles.slice(maxKeep);
      await Promise.all(toDelete.map((f) => fs.unlink(f.path).catch(() => {})));
    } catch (_) {}
  }

  async createBackup(fullPath) {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      const filename = path.basename(fullPath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        this.backupDir,
        `${filename}.${timestamp}.bak`
      );
      await fs.copyFile(fullPath, backupPath);

      // Async background pruning
      this.pruneBackups().catch(() => {});

      return backupPath;
    } catch (_) {
      return null;
    }
  }

  isBinaryFile(filePath, buffer) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return true;
    }
    if (buffer) {
      const checkLength = Math.min(buffer.length, 1024);
      for (let i = 0; i < checkLength; i++) {
        if (buffer[i] === 0) return true;
      }
    }
    return false;
  }

  /**
   * Memory-safe command execution:
   * 1. Caps memory accumulation during output streaming (prevents OOM crashes)
   * 2. Uses process groups to cleanly kill trees
   * 3. Prevents memory leaks by capping history
   */
  async runCommand(command, onOutputChunk = null, timeout = 90000) {
    const trimmed = (command || '').trim();
    if (!trimmed) {
      return { success: false, error: 'Komut boş olamaz.' };
    }

    const risk = this.getRiskAssessment(trimmed);
    if (risk.level === 'blocked') {
      return {
        success: false,
        exitCode: -1,
        error: `Güvenlik Engeli: '${trimmed}' komutu sistem güvenliği nedeniyle engellendi!`,
      };
    }

    let processedCmd = trimmed;

    // Safety auto-fixes for common hanging traps
    if (/^ping\s+/i.test(processedCmd) && !processedCmd.includes('-c')) {
      processedCmd = processedCmd.replace(/^ping\s+/i, 'ping -c 4 ');
    }
    if (/^top$/i.test(processedCmd)) {
      processedCmd = 'top -b -n 1';
    }

    const CWD_MARKER = '___AGENT_NEW_CWD___:';
    const wrappedScript = `
${processedCmd}
__AGENT_CMD_EXIT__=$?
echo ""
echo -n "${CWD_MARKER}"
pwd
exit $__AGENT_CMD_EXIT__
`;

    const startTime = Date.now();
    const MAX_ACCUMULATED_BYTES = 50 * 1024; // 50KB heap limit per command output

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isTimedOut = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Spawn in detached process group for clean subtree kill
      const child = spawn('/bin/bash', ['-c', wrappedScript], {
        cwd: this.cwd,
        env: this.getEnv(),
        detached: true,
      });

      this.activeChildProcess = child;

      const timer = setTimeout(() => {
        isTimedOut = true;
        this.cancelActiveCommand();
      }, timeout);

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        // Memory guard: Cap in-memory accumulation strictly to prevent heap bloating
        if (stdout.length < MAX_ACCUMULATED_BYTES) {
          const remaining = MAX_ACCUMULATED_BYTES - stdout.length;
          if (str.length <= remaining) {
            stdout += str;
          } else {
            stdout += str.slice(0, remaining);
            stdoutTruncated = true;
            stdout +=
              '\n... [Çıktı bellek emniyeti için 50KB ile sınırlandırıldı]';
          }
        } else if (!stdoutTruncated) {
          stdoutTruncated = true;
          stdout +=
            '\n... [Çıktı bellek emniyeti için 50KB ile sınırlandırıldı]';
        }
        if (onOutputChunk) {
          try {
            onOutputChunk({ type: 'stdout', data: str });
          } catch (_) {}
        }
      });

      child.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        if (stderr.length < MAX_ACCUMULATED_BYTES) {
          const remaining = MAX_ACCUMULATED_BYTES - stderr.length;
          if (str.length <= remaining) {
            stderr += str;
          } else {
            stderr += str.slice(0, remaining);
            stderrTruncated = true;
            stderr += '\n... [Hata çıktısı sınırlandırıldı]';
          }
        } else if (!stderrTruncated) {
          stderrTruncated = true;
          stderr += '\n... [Hata çıktısı sınırlandırıldı]';
        }
        if (onOutputChunk) {
          try {
            onOutputChunk({ type: 'stderr', data: str });
          } catch (_) {}
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeChildProcess = null;
        const durationMs = Date.now() - startTime;

        if (isTimedOut) {
          resolve({
            success: false,
            exitCode: -1,
            stdout: stdout.trim(),
            stderr: `Zaman aşımı: Komut ${timeout / 1000} saniye içinde tamamlanamadığı için durduruldu.`,
            error: 'Zaman aşımı',
            cwd: this.cwd,
            durationMs,
          });
          return;
        }

        let cleanStdout = stdout;
        const cwdIdx = stdout.lastIndexOf(CWD_MARKER);
        if (cwdIdx !== -1) {
          const rawCwd = stdout
            .substring(cwdIdx + CWD_MARKER.length)
            .trim()
            .split('\n')[0];
          if (rawCwd && fsSync.existsSync(rawCwd)) {
            this.cwd = rawCwd;
          }
          cleanStdout = stdout.substring(0, cwdIdx).trim();
        }

        const result = {
          success: code === 0,
          exitCode: code ?? 0,
          stdout: cleanStdout.trim(),
          stderr: stderr.trim(),
          cwd: this.cwd,
          durationMs,
          riskLevel: risk.level,
        };

        // Bounded history to prevent memory leak
        this.history.push({
          command: trimmed.substring(0, 200),
          exitCode: code ?? 0,
          durationMs,
          timestamp: new Date().toISOString(),
        });
        if (this.history.length > this.MAX_HISTORY) {
          this.history.shift();
        }

        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeChildProcess = null;
        resolve({
          success: false,
          exitCode: -1,
          stdout: stdout.trim(),
          stderr: err.message,
          error: err.message,
          cwd: this.cwd,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  async listDirectory(dirPath) {
    try {
      const fullPath = this.resolvePath(dirPath || this.cwd);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      const files = [];
      const dirs = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          dirs.push(`📁 ${entry.name}/`);
        } else {
          files.push(`📄 ${entry.name}`);
        }
      }

      dirs.sort();
      files.sort();

      const listing = [...dirs, ...files].join('\n');
      return {
        success: true,
        is_directory: true,
        path: fullPath,
        count: entries.length,
        content: `[DİZİN İÇERİĞİ: ${fullPath}]\n${listing || '(Dizin boş)'}`,
      };
    } catch (err) {
      return { success: false, error: `Dizin listelenemedi: ${err.message}` };
    }
  }

  async fileInfo(filePath) {
    try {
      const fullPath = this.resolvePath(filePath);
      const stat = await fs.stat(fullPath);

      return {
        success: true,
        path: fullPath,
        isDirectory: stat.isDirectory(),
        sizeBytes: stat.size,
        sizeHuman:
          stat.size < 1024
            ? `${stat.size} B`
            : `${(stat.size / 1024).toFixed(1)} KB`,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        error: `Dosya bilgisi alınamadı: ${err.message}`,
      };
    }
  }

  /**
   * Safe file reader with handle leak prevention and size limits
   */
  async readFile(filePath, startLine = 1, endLine = null) {
    let fileHandle = null;
    try {
      const fullPath = this.resolvePath(filePath);

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (_) {
        return { success: false, error: `Dosya bulunamadı: ${filePath}` };
      }

      if (stat.isDirectory()) {
        return await this.listDirectory(fullPath);
      }

      if (this.isBinaryFile(fullPath)) {
        return {
          success: true,
          path: fullPath,
          isBinary: true,
          content: `[BİNARY DOSYA: ${path.basename(fullPath)}]\nBoyut: ${(stat.size / 1024).toFixed(1)} KB. Binary dosyaların içeriği metin olarak gösterilemez.`,
        };
      }

      // Memory-safe chunk reading for large files (> 2MB)
      const MAX_AUTO_READ_BYTES = 2 * 1024 * 1024;
      if (stat.size > MAX_AUTO_READ_BYTES && !endLine) {
        fileHandle = await fs.open(fullPath, 'r');
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await fileHandle.read(
          buffer,
          0,
          buffer.length,
          0
        );

        const rawText = buffer.toString('utf-8', 0, bytesRead);
        const lines = rawText.split('\n').slice(0, 100);
        const numbered = lines.map((l, i) => `${i + 1} | ${l}`).join('\n');

        return {
          success: true,
          path: fullPath,
          totalSize: stat.size,
          warning: `Dosya çok büyük (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Sadece ilk 100 satır gösteriliyor. Belirli bir aralık için start_line ve end_line kullanın.`,
          content: numbered,
        };
      }

      const rawContent = await fs.readFile(fullPath, 'utf-8');
      const lines = rawContent.split(/\r?\n/);
      const totalLines = lines.length;

      const start = Math.max(0, parseInt(startLine, 10) - 1);
      const end = endLine
        ? Math.min(totalLines, parseInt(endLine, 10))
        : totalLines;
      const selected = lines.slice(start, end);

      const formatted = selected
        .map((line, idx) => `${start + idx + 1} | ${line}`)
        .join('\n');

      return {
        success: true,
        path: fullPath,
        totalLines,
        linesRead: `${start + 1}-${end}`,
        content: formatted,
        rawContent: selected.join('\n'),
      };
    } catch (err) {
      return { success: false, error: `Dosya okunamadı: ${err.message}` };
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }
  }

  /**
   * Crash-safe atomic writer with temp file cleanup on error
   */
  async writeFile(filePath, content, append = false) {
    let tempPath = null;
    try {
      const fullPath = this.resolvePath(filePath);

      if (this.isProtectedPath(fullPath)) {
        return {
          success: false,
          error: `Güvenlik Engeli: '${fullPath}' kritik bir sistem dizinidir ve üzerine yazılamaz!`,
        };
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      let backupPath = null;
      let isOverwrite = false;

      if (fsSync.existsSync(fullPath)) {
        isOverwrite = true;
        backupPath = await this.createBackup(fullPath);
      }

      if (append) {
        await fs.appendFile(fullPath, content, 'utf-8');
        return {
          success: true,
          path: fullPath,
          isAppend: true,
          bytesAppended: Buffer.byteLength(content, 'utf-8'),
          message: `İçerik başarıyla dosyanın sonuna eklendi: ${fullPath}`,
        };
      }

      tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
      await fs.writeFile(tempPath, content, 'utf-8');
      await fs.rename(tempPath, fullPath);
      tempPath = null; // Successfully renamed

      const byteSize = Buffer.byteLength(content, 'utf-8');
      let msg = isOverwrite
        ? `Dosya başarıyla güncellendi: ${fullPath} (${byteSize} bayt).`
        : `Yeni dosya başarıyla oluşturuldu: ${fullPath} (${byteSize} bayt).`;

      if (backupPath) {
        msg += ` (Eski sürüm yedeklendi: ${path.basename(backupPath)})`;
      }

      return {
        success: true,
        path: fullPath,
        bytesWritten: byteSize,
        backupCreated: backupPath,
        isOverwrite,
        message: msg,
      };
    } catch (err) {
      return { success: false, error: `Dosya yazılamadı: ${err.message}` };
    } finally {
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => {});
      }
    }
  }

  stripLineNumbers(str) {
    if (!str) return '';
    const lines = String(str).split(/\r?\n/);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (
      nonEmpty.length > 0 &&
      nonEmpty.every((l) => /^\s*\d+\s*[|:]\s?/.test(l))
    ) {
      return lines.map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n');
    }
    return String(str);
  }

  /**
   * Safe multi-strategy file editing with temp file cleanup
   */
  async editFile(
    filePath,
    target,
    replacement,
    startLine = null,
    endLine = null
  ) {
    let tempPath = null;
    try {
      const fullPath = this.resolvePath(filePath);

      if (this.isProtectedPath(fullPath)) {
        return {
          success: false,
          error: `Güvenlik Engeli: '${fullPath}' kritik bir sistem dizinidir ve düzenlenemez!`,
        };
      }

      if (!fsSync.existsSync(fullPath)) {
        return {
          success: false,
          error: `Düzenlenecek dosya bulunamadı: ${filePath}`,
        };
      }

      let content = await fs.readFile(fullPath, 'utf-8');
      const isCRLF = content.includes('\r\n');
      const lineSeparator = isCRLF ? '\r\n' : '\n';

      let cleanTarget = this.stripLineNumbers(target || '');
      let cleanReplacement = this.stripLineNumbers(replacement || '');

      const backupPath = await this.createBackup(fullPath);

      // STRATEGY 1: Explicit Line Range Replacement
      if (
        startLine !== null &&
        startLine !== undefined &&
        String(startLine).trim() !== ''
      ) {
        const fileLines = content.split(/\r?\n/);
        const start = Math.max(1, parseInt(startLine, 10));
        const end =
          endLine !== null &&
          endLine !== undefined &&
          String(endLine).trim() !== ''
            ? Math.max(start, Math.min(parseInt(endLine, 10), fileLines.length))
            : start;

        const replacementLines = cleanReplacement.split(/\r?\n/);
        fileLines.splice(start - 1, end - start + 1, ...replacementLines);

        const updated = fileLines.join(lineSeparator);
        tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        await fs.writeFile(tempPath, updated, 'utf-8');
        await fs.rename(tempPath, fullPath);
        tempPath = null;

        let msg = `Satır ${start}-${end} aralığı başarıyla güncellendi: ${fullPath}.`;
        if (backupPath) msg += ` (Yedek: ${path.basename(backupPath)})`;

        return {
          success: true,
          path: fullPath,
          strategy: 'line_range',
          linesModified: `${start}-${end}`,
          backupCreated: backupPath,
          message: msg,
        };
      }

      // STRATEGY 2: Exact Substring Match
      if (cleanTarget && content.includes(cleanTarget)) {
        const occurrences = content.split(cleanTarget).length - 1;
        const updated = content.replaceAll(cleanTarget, cleanReplacement);

        tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        await fs.writeFile(tempPath, updated, 'utf-8');
        await fs.rename(tempPath, fullPath);
        tempPath = null;

        let msg = `${occurrences} adet eşleşme başarıyla güncellendi: ${fullPath}.`;
        if (backupPath) msg += ` (Yedek: ${path.basename(backupPath)})`;

        return {
          success: true,
          path: fullPath,
          strategy: 'exact_match',
          replacements: occurrences,
          backupCreated: backupPath,
          message: msg,
        };
      }

      // STRATEGY 3: Normalized Line-Ending Match
      const normContent = content.replace(/\r\n/g, '\n');
      const normTarget = cleanTarget.replace(/\r\n/g, '\n');
      const normReplacement = cleanReplacement.replace(/\r\n/g, '\n');

      if (cleanTarget && normContent.includes(normTarget)) {
        const occurrences = normContent.split(normTarget).length - 1;
        let updated = normContent.replaceAll(normTarget, normReplacement);
        if (isCRLF) {
          updated = updated.replace(/\n/g, '\r\n');
        }

        tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        await fs.writeFile(tempPath, updated, 'utf-8');
        await fs.rename(tempPath, fullPath);
        tempPath = null;

        let msg = `${occurrences} adet eşleşme normalizasyonla güncellendi: ${fullPath}.`;
        if (backupPath) msg += ` (Yedek: ${path.basename(backupPath)})`;

        return {
          success: true,
          path: fullPath,
          strategy: 'normalized_match',
          replacements: occurrences,
          backupCreated: backupPath,
          message: msg,
        };
      }

      // STRATEGY 4: Fuzzy Trimmed Block Match
      if (cleanTarget) {
        const fileLines = content.split(/\r?\n/);
        const targetLines = cleanTarget
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0);

        if (targetLines.length > 0 && fileLines.length >= targetLines.length) {
          const tClean = targetLines.map((l) => l.trim());
          let matchIndex = -1;
          let matchCount = 0;

          for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
            let matches = true;
            for (let j = 0; j < targetLines.length; j++) {
              if (fileLines[i + j].trim() !== tClean[j]) {
                matches = false;
                break;
              }
            }
            if (matches) {
              matchIndex = i;
              matchCount++;
            }
          }

          if (matchCount === 1) {
            const firstMatchedLine = fileLines[matchIndex];
            const baseIndent = firstMatchedLine.match(/^(\s*)/)[1] || '';

            const repLines = cleanReplacement.split(/\r?\n/).map((l) => {
              if (l.trim().length > 0 && !/^\s/.test(l)) {
                return baseIndent + l;
              }
              return l;
            });

            fileLines.splice(matchIndex, targetLines.length, ...repLines);

            const updated = fileLines.join(lineSeparator);
            tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
            await fs.writeFile(tempPath, updated, 'utf-8');
            await fs.rename(tempPath, fullPath);
            tempPath = null;

            let msg = `Hedef blok girintiler tolere edilerek başarıyla güncellendi (Satır ${matchIndex + 1}-${matchIndex + targetLines.length}): ${fullPath}.`;
            if (backupPath) msg += ` (Yedek: ${path.basename(backupPath)})`;

            return {
              success: true,
              path: fullPath,
              strategy: 'fuzzy_indent_match',
              lineMatched: matchIndex + 1,
              backupCreated: backupPath,
              message: msg,
            };
          }
        }
      }

      // STRATEGY 5: Single Line Partial Search
      if (cleanTarget && !cleanTarget.includes('\n')) {
        const fileLines = content.split(/\r?\n/);
        const tTrim = cleanTarget.trim();
        const matchingIndices = [];

        fileLines.forEach((line, idx) => {
          if (line.includes(tTrim)) {
            matchingIndices.push(idx);
          }
        });

        if (matchingIndices.length === 1) {
          const idx = matchingIndices[0];
          fileLines[idx] = fileLines[idx].replace(
            tTrim,
            cleanReplacement.trim()
          );

          const updated = fileLines.join(lineSeparator);
          tempPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
          await fs.writeFile(tempPath, updated, 'utf-8');
          await fs.rename(tempPath, fullPath);
          tempPath = null;

          let msg = `Satır ${idx + 1} başarıyla güncellendi: ${fullPath}.`;
          if (backupPath) msg += ` (Yedek: ${path.basename(backupPath)})`;

          return {
            success: true,
            path: fullPath,
            strategy: 'single_line_search',
            lineModified: idx + 1,
            backupCreated: backupPath,
            message: msg,
          };
        }
      }

      return {
        success: false,
        error: `Değiştirilmek istenen hedef metin dosya içinde bulunamadı.`,
        hint: `Hedef metni tam yazabilir veya alternatif olarak "start_line" ve "end_line" belirterek doğrudan satır aralığını değiştirebilirsiniz.`,
        targetSearched: cleanTarget.substring(0, 200),
      };
    } catch (err) {
      return { success: false, error: `Dosya düzenlenemedi: ${err.message}` };
    } finally {
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => {});
      }
    }
  }

  async fetchUrl(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DeepSeek-Agent',
        },
      });

      const text = await response.text();
      const MAX_LEN = 8000;
      const truncated =
        text.length > MAX_LEN
          ? text.substring(0, MAX_LEN) + '\n... [İçerik kısaltıldı]'
          : text;

      return {
        success: true,
        status: response.status,
        url,
        content: truncated,
      };
    } catch (err) {
      return {
        success: false,
        error: `URL çekilemedi (${url}): ${err.message}`,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
