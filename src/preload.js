const { contextBridge, ipcRenderer } = require('electron');

// Expose safe Linux system operations bridge
contextBridge.exposeInMainWorld('agentBridge', {
  runCommand: (cmd, timeout) =>
    ipcRenderer.invoke('agent:run-command', cmd, timeout),
  cancelCommand: () => ipcRenderer.invoke('agent:cancel-command'),
  getCommandRisk: (cmd) => ipcRenderer.invoke('agent:get-command-risk', cmd),
  getCwd: () => ipcRenderer.invoke('agent:get-cwd'),
  readFile: (filePath, start, end) =>
    ipcRenderer.invoke('agent:read-file', filePath, start, end),
  writeFile: (filePath, content, append = false) =>
    ipcRenderer.invoke('agent:write-file', filePath, content, append),
  appendFile: (filePath, content) =>
    ipcRenderer.invoke('agent:append-file', filePath, content),
  editFile: (filePath, target, rep, startLine, endLine) =>
    ipcRenderer.invoke(
      'agent:edit-file',
      filePath,
      target,
      rep,
      startLine,
      endLine
    ),
  listDirectory: (dirPath) =>
    ipcRenderer.invoke('agent:list-directory', dirPath),
  fileInfo: (filePath) => ipcRenderer.invoke('agent:file-info', filePath),
  fetchUrl: (url) => ipcRenderer.invoke('agent:fetch-url', url),
  getSystemInfo: () => ipcRenderer.invoke('agent:get-system-info'),
  onCommandChunk: (cb) =>
    ipcRenderer.on('agent:command-chunk', (_, chunk) => cb(chunk)),
});

const AGENT_SYSTEM_PROMPT = `[SİSTEM TALİMATI]: Sen kullanıcının yerel Linux (CachyOS x86_64) bilgisayarına doğrudan bağlı otonom bir AI Ajanısın (AI Agent).
Kullanıcı Adı: kazim
Ana Dizin: /home/kazim
Kullanıcının Masaüstü: /home/kazim/Masaüstü (Asla Windows değildir!)

Senin Linux terminalinde komut çalıştırma, dosya okuma ve yazma YETKİN VARDIR. Bu yüzden "bilgisayarınıza erişemem" veya "dosya oluşturamam" DEME.
Görevi gerçekleştirmek için cevabının EN SONUNDA MUTLAKA aşağıdaki JSON formatında tek bir eylem belirt:
\`\`\`json
{
  "thought": "Yapacağın işlemin Türkçe açıklaması",
  "action": "bash" | "write_file" | "append_file" | "read_file" | "edit_file" | "list_directory" | "file_info" | "fetch_url" | "done",
  "command": "çalıştırılacak linux terminal komutu",
  "path": "/home/kazim/Masaüstü/dosya_adi.txt",
  "content": "dosyaya yazılacak içerik",
  "target": "değiştirilecek eski metin (edit_file için)",
  "replacement": "yeni metin (edit_file için)",
  "start_line": 1,
  "end_line": 100,
  "message": "görev bittiğinde kullanıcıya açıklama (action done ise)"
}
\`\`\`
BASH VE SİSTEM KURALLARI:
1. Çalışma Dizini Hafızası: Terminal çalışma dizinini (cwd) hatırlar. "cd <dizin>" yaptığında sonraki adımlarda o dizinde kalırsın.
2. İnteraktif Olmayan Komutlar: Asla etkileşimli bekleyen komut çalıştırma. Örneğin "ping" için mutlaka "ping -c 3", paket yüklerken non-interactive bayrakları (örn. pacman için "--noconfirm") kullan.
3. read_file satır numaralarıyla okur (örn: "1 | satır"). Dizin verilirse otomatik olarak dizin içeriğini listeler.
4. write_file mevcut dosyanın üzerine yazarken otomatik yedek (.bak) alır.
5. append_file mevcut dosyanın sonuna ekleme yapar.
6. edit_file hedef metni güvenle değiştirir.
7. Asla komut çıktısı uydurma. Sen bu JSON'u ürettiğinde sistem yerel olarak komutu çalıştırıp sana [SİSTEM ÇIKTISI] olarak gerçek çıktıyı gönderecektir.`;

// Internal Agent State & Bounded Memory Structures
let agentEnabled = true;
let autoApprove = false;
let isTransforming = false;
let isExecuting = false;
let pendingAction = null;

// Capped Set to prevent memory leaks during long-running sessions
const MAX_PROCESSED_ACTIONS = 60;
const processedActions = new Set();

function recordProcessedAction(sig) {
  processedActions.add(sig);
  if (processedActions.size > MAX_PROCESSED_ACTIONS) {
    const oldest = processedActions.values().next().value;
    processedActions.delete(oldest);
  }
}

// Injected Overlay Initialization
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('agent-toolbar')) return; // Prevent double injection on reload
  injectAgentStyles();
  injectAgentToolbar();
  setupMessageInterceptor();
  startActionObserver();
  setupStreamingListener();
});

function injectAgentStyles() {
  if (document.getElementById('deepseek-agent-styles')) return;
  const style = document.createElement('style');
  style.id = 'deepseek-agent-styles';
  style.textContent = `
    #agent-toolbar {
      position: fixed;
      top: 12px;
      right: 70px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(18, 20, 24, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      padding: 6px 14px;
      border-radius: 30px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      user-select: none;
      transition: all 0.2s ease;
    }
    #agent-toolbar:hover {
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6);
    }
    .agent-title {
      font-weight: 600;
      color: #60a5fa;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .agent-btn {
      background: rgba(96, 165, 250, 0.2);
      border: 1px solid rgba(96, 165, 250, 0.4);
      color: #fff;
      padding: 4px 12px;
      border-radius: 16px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .agent-btn:hover {
      background: rgba(96, 165, 250, 0.35);
      border-color: #60a5fa;
    }
    .agent-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .agent-toggle input {
      cursor: pointer;
      accent-color: #3b82f6;
    }
    
    /* Confirmation Modal Card */
    #agent-modal-card {
      position: fixed;
      bottom: 90px;
      right: 24px;
      z-index: 999999;
      width: 480px;
      background: #16181d;
      border: 1px solid #3b82f6;
      border-radius: 12px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.75);
      padding: 16px;
      color: #f3f4f6;
      font-family: inherit;
      display: none;
      animation: agentSlideUp 0.25s ease-out;
    }
    @keyframes agentSlideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 8px;
      margin-bottom: 12px;
      font-weight: 600;
      color: #60a5fa;
    }
    .modal-body {
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 14px;
      max-height: 320px;
      overflow-y: auto;
    }
    .modal-code {
      background: #0d1117;
      padding: 8px 10px;
      border-radius: 6px;
      font-family: monospace;
      color: #7ee787;
      margin-top: 6px;
      word-break: break-all;
      border: 1px solid rgba(255, 255, 255, 0.08);
      white-space: pre-wrap;
    }
    .modal-terminal {
      background: #000;
      color: #38bdf8;
      font-family: monospace;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      margin-top: 8px;
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid #1e293b;
      white-space: pre-wrap;
      word-break: break-all;
      display: none;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .btn-approve {
      background: #2563eb;
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-approve:hover {
      background: #1d4ed8;
    }
    .btn-deny {
      background: rgba(255, 255, 255, 0.08);
      color: #9ca3af;
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-deny:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
      border-color: #ef4444;
    }
    .btn-stop {
      background: #dc2626;
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
      display: none;
    }
    .btn-stop:hover {
      background: #b91c1c;
    }

    /* Toast Notification */
    #agent-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999999;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #334155;
      padding: 8px 18px;
      border-radius: 20px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      font-size: 13px;
      display: none;
      animation: agentFade 0.2s ease;
    }
  `;
  document.head.appendChild(style);
}

function injectAgentToolbar() {
  const bar = document.createElement('div');
  bar.id = 'agent-toolbar';
  bar.innerHTML = `
    <div class="agent-title">🤖 <span>Linux Agent</span></div>
    <label class="agent-toggle" title="Ajan modunu aç/kapat">
      <input type="checkbox" id="agent-active-chk" checked>
      <span>Ajan</span>
    </label>
    <label class="agent-toggle" title="Komutları sormadan doğrudan çalıştır">
      <input type="checkbox" id="agent-auto-chk">
      <span>Oto-Onay</span>
    </label>
    <button class="agent-btn" id="agent-prompt-btn" title="Mesaj kutusuna manuel ajan talimatı ekler">
      🎯 Ajan Talimatı
    </button>
  `;
  document.body.appendChild(bar);

  // Modal
  const modal = document.createElement('div');
  modal.id = 'agent-modal-card';
  modal.innerHTML = `
    <div class="modal-header">
      <span id="modal-action-title">⚡ Eylem İsteği</span>
      <span id="modal-action-badge" style="font-size: 11px; background: rgba(96,165,250,0.2); padding: 2px 8px; border-radius: 12px; font-weight: 500;">bash</span>
    </div>
    <div class="modal-body">
      <div id="modal-action-thought" style="color: #9ca3af; margin-bottom: 6px;"></div>
      <div id="modal-action-detail" class="modal-code"></div>
      <div id="modal-action-terminal" class="modal-terminal"></div>
    </div>
    <div class="modal-actions">
      <button class="btn-deny" id="modal-btn-deny">✗ Reddet</button>
      <button class="btn-stop" id="modal-btn-stop">⛔ Durdur / İptal Et</button>
      <button class="btn-approve" id="modal-btn-approve">✓ Onayla ve Çalıştır</button>
    </div>
  `;
  document.body.appendChild(modal);

  // Toast
  const toast = document.createElement('div');
  toast.id = 'agent-toast';
  document.body.appendChild(toast);

  // Event Listeners
  document
    .getElementById('agent-active-chk')
    .addEventListener('change', (e) => {
      agentEnabled = e.target.checked;
      showToast(agentEnabled ? 'Ajan Modu Aktif' : 'Ajan Modu Devre Dışı');
    });

  document.getElementById('agent-auto-chk').addEventListener('change', (e) => {
    autoApprove = e.target.checked;
    showToast(autoApprove ? '⚡ Otomatik Onay: AÇIK' : 'Otomatik Onay: KAPALI');
  });

  document.getElementById('agent-prompt-btn').addEventListener('click', () => {
    injectSystemPromptManually();
  });

  document.getElementById('modal-btn-approve').addEventListener('click', () => {
    if (pendingAction) {
      const act = pendingAction;
      pendingAction = null;
      executeAction(act);
    }
  });

  document.getElementById('modal-btn-deny').addEventListener('click', () => {
    if (pendingAction) {
      pendingAction = null;
      hideModal();
      sendOutputToDeepSeek(
        '[SİSTEM]: Kullanıcı bu eylemi çalıştırmayı reddetti.'
      );
    }
  });

  document
    .getElementById('modal-btn-stop')
    .addEventListener('click', async () => {
      showToast('⛔ Komut durduruluyor...');
      await ipcRenderer.invoke('agent:cancel-command');
    });
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('agent-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => {
    if (toast) toast.style.display = 'none';
  }, duration);
}

// Bounded terminal streaming buffer to prevent Chromium DOM memory bloat
const MAX_TERMINAL_CHARS = 25000;

function setupStreamingListener() {
  ipcRenderer.removeAllListeners('agent:command-chunk');
  ipcRenderer.on('agent:command-chunk', (_, chunk) => {
    const term = document.getElementById('modal-action-terminal');
    if (!term || !chunk || !chunk.data) return;

    term.style.display = 'block';
    let newContent = term.textContent + chunk.data;
    if (newContent.length > MAX_TERMINAL_CHARS) {
      newContent =
        '[...Önceki çıktılar bellek koruması için kırpıldı...]\n' +
        newContent.slice(-MAX_TERMINAL_CHARS);
    }
    term.textContent = newContent;
    term.scrollTop = term.scrollHeight;
  });
}

async function showModal(action) {
  pendingAction = action;
  const modal = document.getElementById('agent-modal-card');
  const title = document.getElementById('modal-action-title');
  const badge = document.getElementById('modal-action-badge');
  const thought = document.getElementById('modal-action-thought');
  const detail = document.getElementById('modal-action-detail');
  const term = document.getElementById('modal-action-terminal');
  const btnApprove = document.getElementById('modal-btn-approve');
  const btnDeny = document.getElementById('modal-btn-deny');
  const btnStop = document.getElementById('modal-btn-stop');

  if (!modal || !title || !badge || !detail) return;

  if (term) {
    term.style.display = 'none';
    term.textContent = '';
  }
  if (btnStop) btnStop.style.display = 'none';
  if (btnApprove) btnApprove.style.display = 'block';
  if (btnDeny) btnDeny.style.display = 'block';

  thought.textContent = action.thought || 'Bir sistem işlemi isteniyor.';

  if (action.action === 'bash') {
    const risk = await ipcRenderer.invoke(
      'agent:get-command-risk',
      action.command
    );
    const cwd = await ipcRenderer.invoke('agent:get-cwd');

    badge.textContent = risk.label;
    badge.style.background = risk.color + '26';
    badge.style.color = risk.color;

    title.textContent = '⚡ Terminal Komutu';
    detail.textContent = `📁 Çalışma Dizini: ${cwd}\n$ ${action.command || ''}`;
  } else if (action.action === 'write_file') {
    badge.textContent = 'write_file';
    badge.style.background = 'rgba(96,165,250,0.2)';
    badge.style.color = '#60a5fa';

    title.textContent = '📝 Dosya Yazma (Otomatik Yedeklemeli)';
    const preview = (action.content || '').substring(0, 300);
    const extra =
      (action.content || '').length > 300
        ? '\n... [kalan içerik gizlendi]'
        : '';
    detail.textContent = `Hedef: ${action.path}\nİçerik Uzunluğu: ${(action.content || '').length} karakter\n\n${preview}${extra}`;
  } else if (action.action === 'append_file') {
    badge.textContent = 'append_file';
    badge.style.background = 'rgba(96,165,250,0.2)';
    badge.style.color = '#60a5fa';

    title.textContent = '➕ Dosyanın Sonuna Ekleme';
    detail.textContent = `Hedef: ${action.path}\nEklenecek Metin:\n${action.content || ''}`;
  } else if (action.action === 'read_file') {
    badge.textContent = 'read_file';
    badge.style.background = 'rgba(74,222,128,0.2)';
    badge.style.color = '#4ade80';

    title.textContent = '📖 Dosya Okuma';
    detail.textContent = `Dosya/Dizin: ${action.path}${action.start_line ? ` (Satırlar: ${action.start_line}-${action.end_line || 'son'})` : ''}`;
  } else if (action.action === 'edit_file') {
    badge.textContent = 'edit_file';
    badge.style.background = 'rgba(251,191,36,0.2)';
    badge.style.color = '#fbbf24';

    title.textContent = '✏️ Dosya Düzenleme';
    const rep = action.replacement || action.content || '';
    if (action.start_line || action.line) {
      const start = action.start_line || action.line;
      const end = action.end_line || start;
      detail.textContent = `Dosya: ${action.path}\nSatır Aralığı: ${start}-${end}\n\n[+] Yeni İçerik:\n${rep}`;
    } else {
      detail.textContent = `Dosya: ${action.path}\n\n[-] Eski Metin:\n${action.target || ''}\n\n[+] Yeni Metin:\n${rep}`;
    }
  } else if (action.action === 'list_directory') {
    badge.textContent = 'list_directory';
    badge.style.background = 'rgba(74,222,128,0.2)';
    badge.style.color = '#4ade80';

    title.textContent = '📁 Dizin Listeleme';
    detail.textContent = `Dizin: ${action.path || '.'}`;
  } else if (action.action === 'file_info') {
    badge.textContent = 'file_info';
    badge.style.background = 'rgba(74,222,128,0.2)';
    badge.style.color = '#4ade80';

    title.textContent = 'ℹ️ Dosya Bilgisi';
    detail.textContent = `Dosya: ${action.path}`;
  } else if (action.action === 'fetch_url') {
    badge.textContent = 'fetch_url';
    badge.style.background = 'rgba(96,165,250,0.2)';
    badge.style.color = '#60a5fa';

    title.textContent = '🌐 Web Verisi Çekme';
    detail.textContent = `URL: ${action.url}`;
  } else {
    badge.textContent = action.action;
    title.textContent = '⚡ Sistem Eylemi';
    detail.textContent = JSON.stringify(action, null, 2);
  }

  modal.style.display = 'block';
}

function hideModal() {
  const modal = document.getElementById('agent-modal-card');
  if (modal) modal.style.display = 'none';
}

// Automatically wraps user requests with Agent System Instructions so DeepSeek never says "I cannot access"
function setupMessageInterceptor() {
  document.addEventListener(
    'keydown',
    (e) => {
      if (!agentEnabled || isTransforming) return;
      const textarea =
        document.querySelector('textarea#chat-input') ||
        document.querySelector('textarea');
      if (!textarea || e.target !== textarea) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        handleUserSubmit(textarea, e);
      }
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!agentEnabled || isTransforming) return;
      const textarea =
        document.querySelector('textarea#chat-input') ||
        document.querySelector('textarea');
      if (!textarea) return;

      const btn = e.target.closest('div[role="button"], button');
      if (
        btn &&
        btn.querySelector('svg') &&
        !btn.closest('#agent-toolbar') &&
        !btn.closest('#agent-modal-card')
      ) {
        handleUserSubmit(textarea, e);
      }
    },
    true
  );
}

function handleUserSubmit(textarea, event) {
  const text = (textarea.value || '').trim();
  if (!text) return;

  // If already contains system tags, let it pass through normally
  if (
    text.startsWith('[SİSTEM TALİMATI]') ||
    text.startsWith('[SİSTEM ÇIKTISI]')
  ) {
    return;
  }

  // Intercept and wrap with Agent instructions
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  isTransforming = true;
  const fullPrompt = `${AGENT_SYSTEM_PROMPT}\n\nKULLANICI GÖREVİ:\n${text}`;

  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  setter.call(textarea, fullPrompt);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  showToast('🤖 Ajan Talimatı Otomatik Eklendi...');

  setTimeout(() => {
    isTransforming = false;
    const buttons = Array.from(
      document.querySelectorAll('div[role="button"], button')
    );
    let clicked = false;
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (
        b.querySelector('svg') &&
        !b.closest('#agent-toolbar') &&
        !b.closest('#agent-modal-card') &&
        b.offsetHeight > 0
      ) {
        b.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }
  }, 120);
}

function injectSystemPromptManually() {
  const textarea =
    document.querySelector('textarea#chat-input') ||
    document.querySelector('textarea');
  if (!textarea) {
    showToast('Hata: Mesaj kutusu bulunamadı!');
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  setter.call(textarea, `${AGENT_SYSTEM_PROMPT}\n\nKULLANICI GÖREVİ: `);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();
  showToast('✓ Ajan talimatı eklendi!');
}

function sendOutputToDeepSeek(output) {
  const textarea =
    document.querySelector('textarea#chat-input') ||
    document.querySelector('textarea');
  if (!textarea) return;

  isTransforming = true;
  textarea.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  setter.call(textarea, output);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  setTimeout(() => {
    isTransforming = false;
    const buttons = Array.from(
      document.querySelectorAll('div[role="button"], button')
    );
    let clicked = false;
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      if (
        btn.querySelector('svg') &&
        !btn.closest('#agent-toolbar') &&
        !btn.closest('#agent-modal-card') &&
        btn.offsetHeight > 0
      ) {
        btn.click();
        clicked = true;
        break;
      }
    }
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
  }, 400);
}

async function executeAction(action) {
  if (isExecuting) return;
  isExecuting = true;

  showToast(`⚡ Yürütülüyor: ${action.action}...`);
  let resultOutput = '';

  const modal = document.getElementById('agent-modal-card');
  const term = document.getElementById('modal-action-terminal');
  const btnApprove = document.getElementById('modal-btn-approve');
  const btnDeny = document.getElementById('modal-btn-deny');
  const btnStop = document.getElementById('modal-btn-stop');

  if (action.action === 'bash' && modal && term) {
    modal.style.display = 'block';
    term.style.display = 'block';
    term.textContent = `[Çalıştırılıyor: $ ${action.command}]\n`;
    if (btnApprove) btnApprove.style.display = 'none';
    if (btnDeny) btnDeny.style.display = 'none';
    if (btnStop) btnStop.style.display = 'block';
  }

  try {
    if (action.action === 'bash') {
      const res = await ipcRenderer.invoke('agent:run-command', action.command);
      resultOutput = `[SİSTEM ÇIKTISI]\nÇıkış Kodu (Exit Code): ${res.exitCode}\nÇalışma Dizini: ${res.cwd}\nSüre: ${res.durationMs || 0}ms\nÇıktı:\n${res.stdout || '(Boş)'}`;
      if (res.stderr) resultOutput += `\nHata (Stderr):\n${res.stderr}`;
    } else if (action.action === 'read_file') {
      const res = await ipcRenderer.invoke(
        'agent:read-file',
        action.path,
        action.start_line,
        action.end_line
      );
      if (res.success) {
        resultOutput = `[SİSTEM ÇIKTISI - DOSYA İÇERİĞİ (${res.path})]\n${res.content}`;
        if (res.warning) resultOutput += `\n${res.warning}`;
      } else {
        resultOutput = `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
      }
    } else if (action.action === 'write_file') {
      const res = await ipcRenderer.invoke(
        'agent:write-file',
        action.path,
        action.content,
        false
      );
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI]\n${res.message}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
    } else if (action.action === 'append_file') {
      const res = await ipcRenderer.invoke(
        'agent:append-file',
        action.path,
        action.content
      );
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI]\n${res.message}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
    } else if (action.action === 'edit_file') {
      const res = await ipcRenderer.invoke(
        'agent:edit-file',
        action.path,
        action.target,
        action.replacement || action.content,
        action.start_line || action.line,
        action.end_line
      );
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI]\n${res.message}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}${res.hint ? `\nİpucu: ${res.hint}` : ''}`;
    } else if (action.action === 'list_directory') {
      const res = await ipcRenderer.invoke('agent:list-directory', action.path);
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI]\n${res.content}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
    } else if (action.action === 'file_info') {
      const res = await ipcRenderer.invoke('agent:file-info', action.path);
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI - DOSYA BİLGİSİ]\n${JSON.stringify(res, null, 2)}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
    } else if (action.action === 'fetch_url') {
      const res = await ipcRenderer.invoke('agent:fetch-url', action.url);
      resultOutput = res.success
        ? `[SİSTEM ÇIKTISI - WEB YANITI (${res.url})]\n${res.content}`
        : `[SİSTEM ÇIKTISI - HATA]\n${res.error}`;
    } else {
      resultOutput = `[SİSTEM ÇIKTISI - HATA]\nBilinmeyen eylem: ${action.action}`;
    }
  } catch (err) {
    resultOutput = `[SİSTEM ÇIKTISI - KRİTİK HATA]\n${err.message}`;
  } finally {
    isExecuting = false;
    hideModal();
  }

  showToast("✓ Çıktı DeepSeek'e iletiliyor...");
  sendOutputToDeepSeek(
    `${resultOutput}\n\nBir sonraki eylemini veya iş bittiyse done JSON'unu belirt.`
  );
}

function findBalancedJson(text) {
  if (!text) return null;
  let firstBrace = text.indexOf('{');
  while (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(firstBrace, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && parsed.action) {
              return parsed;
            }
          } catch (_) {}
          break;
        }
      }
    }
    firstBrace = text.indexOf('{', firstBrace + 1);
  }
  return null;
}

function parseActionFromElement(element) {
  if (!element) return null;

  // 1. Inspect rendered <pre> and <code> elements directly from the DOM
  const codeBlocks = Array.from(element.querySelectorAll('pre, code'));
  for (const block of codeBlocks) {
    const raw = (block.innerText || '').trim();
    if (!raw) continue;

    // Check if codeblock is JSON action
    const jsonAction = findBalancedJson(raw);
    if (jsonAction) return jsonAction;

    // Check if codeblock is a Bash command or script (including heredocs)
    const isBash =
      /^(cat|echo|sed|awk|mkdir|cd|rm|cp|mv|ls|touch|python|node|npm|curl|chmod|git|grep|dd|find)\b/m.test(
        raw
      ) ||
      raw.includes('<<') ||
      raw.includes('>>') ||
      raw.includes('|');

    if (isBash && !raw.includes('Set-Content') && !raw.includes('powershell')) {
      return {
        action: 'bash',
        command: raw,
        thought: 'DeepSeek tarafından önerilen terminal scripti/komutu',
      };
    }
  }

  // 2. Check full text of the message for balanced JSON
  const fullText = element.innerText || '';
  const jsonAction = findBalancedJson(fullText);
  if (jsonAction) return jsonAction;

  return null;
}

/**
 * Checks if DeepSeek is currently streaming or generating tokens
 */
function isDeepSeekGenerating() {
  const stopBtn = document.querySelector(
    'button[aria-label*="Stop"], button[aria-label*="Durdur"], div[role="button"][aria-label*="Stop"], div[role="button"][aria-label*="Durdur"]'
  );
  if (stopBtn) return true;

  const svgSquares = document.querySelectorAll(
    'button svg rect, div[role="button"] svg rect'
  );
  for (const rect of svgSquares) {
    const btn = rect.closest('button, div[role="button"]');
    if (
      btn &&
      !btn.closest('#agent-toolbar') &&
      !btn.closest('#agent-modal-card')
    ) {
      return true;
    }
  }

  if (document.querySelector('.ds-cursor, .typing-cursor')) return true;

  return false;
}

let lastSeenText = '';

function startActionObserver() {
  setInterval(() => {
    if (!agentEnabled || isExecuting) return;

    // Find markdown message containers
    const containers = document.querySelectorAll(
      '.ds-markdown, div[class*="ds-markdown"], div[class*="markdown"]'
    );
    if (!containers || containers.length === 0) return;

    const lastMessage = containers[containers.length - 1];
    const currentText = (lastMessage.innerText || '').trim();

    // Stability check: if message is still streaming/growing, wait
    if (currentText !== lastSeenText) {
      lastSeenText = currentText;
      return;
    }

    // Check if generation is still active
    if (isDeepSeekGenerating()) return;

    const action = parseActionFromElement(lastMessage);
    if (!action) return;

    // Create unique signature to avoid repeating the same action
    const signature = JSON.stringify(action);
    if (processedActions.has(signature)) return;

    recordProcessedAction(signature);

    if (action.action === 'done') {
      showToast(
        `🎉 DeepSeek: ${action.message || 'Görev başarıyla tamamlandı!'}`,
        5000
      );
      return;
    }

    if (autoApprove) {
      executeAction(action);
    } else {
      showModal(action);
    }
  }, 1000);
}
