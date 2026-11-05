// EUM Desktop Engine — 트레이 상주 앱 (Electron)
// UI 프로세스와 실제 작업 실행(워커)은 분리된 프로세스입니다. 워커는 관리자 권한 없이 실행됩니다.
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, shell, nativeImage } = require('electron');
const { fork, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.EUM_ENGINE_HOME || path.join(os.homedir(), '.eum-engine');
const CONFIG = path.join(HOME, 'config.json');
const ENGINE_CLI = app.isPackaged ? path.join(process.resourcesPath, 'engine', 'src', 'cli.js') : path.join(__dirname, '..', 'dist', 'src', 'cli.js');

let win, tray, worker;
let state = { running: false, status: null, logs: [] };

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
function writeConfig(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const next = { ...readConfig(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}

/** 엔진 토큰을 Windows 자격 증명 보호(DPAPI)로 암호화해 보관하고, 평문은 설정 파일에서 지웁니다. */
function protectToken() {
  const cfg = readConfig();
  if (cfg.agentToken && safeStorage.isEncryptionAvailable()) {
    writeConfig({ agentTokenEnc: safeStorage.encryptString(cfg.agentToken).toString('base64'), agentToken: null });
  }
}
function loadToken() {
  const cfg = readConfig();
  if (cfg.agentTokenEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(cfg.agentTokenEnc, 'base64')); } catch { return undefined; }
  }
  return cfg.agentToken;
}

function push(line) {
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
  win?.webContents.send('state', publicState());
}
function publicState() {
  const { agentToken, agentTokenEnc, ...cfg } = readConfig();
  return { ...state, config: cfg, paired: !!(agentToken || agentTokenEnc), autoStart: app.getLoginItemSettings().openAtLogin };
}

function startWorker() {
  if (worker) return;
  const token = loadToken();
  if (!token) return push('서버에 등록되지 않았습니다. 연결 코드로 PC를 등록하세요.');
  worker = fork(ENGINE_CLI, ['start'], { env: { ...process.env, EUM_ENGINE_HOME: HOME, EUM_AGENT_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  state.running = true;
  const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(push);
  worker.stdout.on('data', onData);
  worker.stderr.on('data', onData);
  worker.on('message', (m) => { if (m?.type === 'status') { state.status = m.status; updateTray(); win?.webContents.send('state', publicState()); } });
  worker.on('exit', (code) => { worker = null; state.running = false; state.status = null; push(`엔진이 종료되었습니다. (코드 ${code})`); updateTray(); });
  updateTray();
}
function stopWorker() {
  if (!worker) return;
  try { worker.send({ type: 'stop' }); } catch { /* 이미 종료 */ }
  const w = worker;
  setTimeout(() => { if (worker === w) w.kill(); }, 8000);
}

function updateTray() {
  if (!tray) return;
  const s = state.status;
  const label = !state.running ? '엔진 중지됨' : !s?.connected ? '서버 연결 중…' : s.paused ? '일시정지' : s.running?.length ? `작업 ${s.running.length}개 실행 중` : '대기 중';
  tray.setToolTip(`EUM Desktop Engine — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: '창 열기', click: showWindow },
    state.running ? { label: '엔진 중지 (실행 중 작업 강제 중단)', click: stopWorker } : { label: '엔진 시작', click: startWorker },
    { label: '작업 폴더 열기', click: () => shell.openPath(readConfig().workspaceRoot || path.join(os.homedir(), 'EUM-Projects')) },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; stopWorker(); setTimeout(() => app.quit(), 500); } },
  ]));
}

function showWindow() {
  if (win) return win.show();
  win = new BrowserWindow({ width: 760, height: 640, title: 'EUM Desktop Engine', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => (win = null));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    protectToken();
    const icon = path.join(__dirname, 'icon.png');
    tray = new Tray(fs.existsSync(icon) ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
    tray.on('double-click', showWindow);
    updateTray();
    if (!process.argv.includes('--hidden')) showWindow();
    if (loadToken()) startWorker();
  });
  app.on('window-all-closed', () => { /* 트레이에 상주 */ });
}

ipcMain.handle('state', () => publicState());
ipcMain.handle('start', () => startWorker());
ipcMain.handle('stop', () => stopWorker());
ipcMain.handle('autostart', (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }));
ipcMain.handle('settings', (_e, patch) => {
  const allowed = ['workspaceRoot', 'maxConcurrency', 'cpuLimitPercent', 'minFreeMemMb'];
  const clean = {};
  for (const k of allowed) if (patch[k] !== undefined && patch[k] !== '') clean[k] = k === 'workspaceRoot' ? String(patch[k]) : Number(patch[k]);
  writeConfig(clean);
  push('설정을 저장했습니다. 엔진을 다시 시작하면 적용됩니다.');
  return publicState();
});
ipcMain.handle('pair', (_e, { server, code, name }) =>
  new Promise((resolve) => {
    // 인자는 배열로 전달하므로 셸 해석이 일어나지 않습니다.
    execFile(process.execPath, [ENGINE_CLI, 'pair', '--server', String(server), '--code', String(code), '--name', String(name || os.hostname())],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EUM_ENGINE_HOME: HOME } },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, message: (stderr || stdout || err.message).trim() });
        protectToken();
        startWorker();
        resolve({ ok: true, message: stdout.trim() });
      });
  }));
