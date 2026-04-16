import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import * as echarts from "echarts";
import { jsPDF } from "jspdf";
import { type CSSProperties, type ClipboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type PortInfo = {
  id: string;
  path: string;
  deviceKey: string;
  friendlyName: string;
  alias?: string;
  preferred: boolean;
  status: string;
};
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

type SerialConfig = {
  port: string;
  baudRate: number;
  dataBits: number;
  stopBits: string;
  parity: string;
  flowControl: string;
  dtr: boolean;
  rts: boolean;
};

type ApiError = {
  code: string;
  message: string;
};

type StatusEvent = {
  connected: boolean;
  port?: string;
  message: string;
};

type IoStats = {
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
};

type RxChunk = {
  bytes: number[];
  timestampMs: number;
  stats: IoStats;
};

type DeviceProfile = {
  deviceKey: string;
  alias?: string;
  preferredPort?: string;
};
type QuickSendItem = {
  id: string;
  name: string;
  payload: string;
  format: SendFormat;
};

type EncodingMode = "auto" | "utf-8" | "gbk" | "ascii";
type SendFormat = "ASCII" | "HEX";
type Lang = "zh-CN" | "zh-TW" | "en" | "ja" | "de";
type ThemeMode = "light" | "dark";
type FileSendFormat =
  | "binary"
  | "ascii"
  | "hex"
  | "xmodem128"
  | "xmodem1024"
  | "ymodem128"
  | "ymodem1024";
type FormState = {
  port: string;
  baudRate: string;
  dataBits: string;
  stopBits: string;
  parity: string;
  flowControl: string;
  dtr: boolean;
  rts: boolean;
};
type PortConfigCache = Omit<FormState, "port">;
type PortConfigCacheEntryRaw = {
  baudRate: number;
  dataBits: number;
  stopBits: string;
  parity: string;
  flowControl: string;
  dtr: boolean;
  rts: boolean;
};
type SerialConfigCachePayload = {
  lastOpened?: SerialConfig | null;
  byPort?: Record<string, PortConfigCacheEntryRaw>;
};
type ChartKind = "line" | "bar";
type ChartWindow = 30 | 100 | 500 | "all";
type ChartExportFormat = "png" | "svg" | "pdf" | "bmp" | "jpg";
type ChartSource = "tx" | "rx" | "both";

function formatBytes(bytes: number[], mode: "ASCII" | "HEX" | "BIN" | "DEC"): string {
  if (mode === "HEX") return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  if (mode === "BIN") return bytes.map((b) => b.toString(2).padStart(8, "0")).join(" ");
  if (mode === "DEC") return bytes.map((b) => String(b)).join(" ");
  return bytes
    .map((b) => {
      if (b >= 32 && b <= 126) return String.fromCharCode(b);
      return ".";
    })
    .join("");
}

function crc16Modbus(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      const lsb = crc & 0x0001;
      crc >>= 1;
      if (lsb) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
}

function crc32Simple(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseHexString(text: string): number[] {
  const compact = text.replace(/\s+/g, "");
  if (!compact || compact.length % 2 !== 0) return [];
  const out: number[] = [];
  for (let i = 0; i < compact.length; i += 2) {
    const n = Number.parseInt(compact.slice(i, i + 2), 16);
    if (Number.isNaN(n)) return [];
    out.push(n);
  }
  return out;
}

function decodeBytesWithEncoding(
  bytes: number[],
  encodingMode: EncodingMode,
): { text: string; usedEncoding: "UTF-8" | "GBK" | "ASCII" } {
  const uint8 = new Uint8Array(bytes);
  const normalizeVisibleText = (text: string) =>
    text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ".");

  const decodeAscii = () => {
    const text = bytes
      .map((b) => {
        if (b >= 32 && b <= 126) return String.fromCharCode(b);
        return ".";
      })
      .join("");
    return { text, usedEncoding: "ASCII" as const };
  };

  const tryDecode = (enc: string, fatal = false): string | null => {
    try {
      return new TextDecoder(enc, { fatal }).decode(uint8);
    } catch {
      return null;
    }
  };

  if (encodingMode === "ascii") return decodeAscii();
  if (encodingMode === "utf-8") {
    const text = normalizeVisibleText(tryDecode("utf-8") ?? decodeAscii().text);
    return { text, usedEncoding: "UTF-8" };
  }
  if (encodingMode === "gbk") {
    const text = normalizeVisibleText(tryDecode("gbk") ?? decodeAscii().text);
    return { text, usedEncoding: "GBK" };
  }

  // auto: UTF-8 -> GBK -> ASCII
  const utf8Strict = tryDecode("utf-8", true);
  if (utf8Strict !== null) return { text: normalizeVisibleText(utf8Strict), usedEncoding: "UTF-8" };
  const gbkText = tryDecode("gbk");
  if (gbkText !== null) return { text: normalizeVisibleText(gbkText), usedEncoding: "GBK" };
  return decodeAscii();
}

function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 超过该间隔认为「接收不连续」，自动换行模式下在块前插入换行（需大于轮询间隔） */
const RX_GAP_WRAP_MS = 350;
const BASE_VIEWPORT_WIDTH = 1280;
const BASE_VIEWPORT_HEIGHT = 800;
const WINDOW_BOUNDS_CACHE_KEY = "uart.windowBounds";
const QUICK_PANEL_WIDTH_KEY = "uart.homeQuickPanelWidth";

function shouldPreferHexByPastedText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/[\s,;|]+/).filter(Boolean);
  const hexByteTokens = tokens.filter((t) => /^[0-9a-fA-F]{2}$/.test(t)).length;
  if (tokens.length >= 2 && hexByteTokens >= 2 && hexByteTokens / tokens.length >= 0.5) return true;
  const compact = trimmed.replace(/\s+/g, "");
  return compact.length >= 4 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact);
}

function extractFirstNumber(text: string): number | null {
  const m = text.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function imageDataToBmpBlob(imageData: ImageData): Blob {
  const { width, height, data } = imageData;
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // BMP header
  bytes[0] = 0x42; // B
  bytes[1] = 0x4d; // M
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); // DIB header size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bpp
  view.setUint32(34, pixelArraySize, true);

  const padding = rowSize - width * 3;
  let offset = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      bytes[offset++] = data[i + 2]; // B
      bytes[offset++] = data[i + 1]; // G
      bytes[offset++] = data[i]; // R
    }
    for (let p = 0; p < padding; p += 1) bytes[offset++] = 0;
  }
  return new Blob([bytes], { type: "image/bmp" });
}

function App() {
  const appWindow = getCurrentWindow();
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("uart.lang");
    if (saved === "zh-CN" || saved === "zh-TW" || saved === "en" || saved === "ja" || saved === "de") {
      return saved;
    }
    const sys = (navigator.language || "en").toLowerCase();
    if (sys.startsWith("zh-tw") || sys.startsWith("zh-hk")) return "zh-TW";
    if (sys.startsWith("zh")) return "zh-CN";
    if (sys.startsWith("ja")) return "ja";
    if (sys.startsWith("de")) return "de";
    return "en";
  });
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("uart.theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [activeTab, setActiveTab] = useState<"home" | "quick-settings" | "advanced">("home");
  const [serialOpen, setSerialOpen] = useState(false);
  const [sendFormat, setSendFormat] = useState<SendFormat>("ASCII");
  const [rxFormat, setRxFormat] = useState<"ASCII" | "HEX" | "BIN" | "DEC">("ASCII");
  const [encodingMode, setEncodingMode] = useState<EncodingMode>("auto");
  const [activeEncoding, setActiveEncoding] = useState<"UTF-8" | "GBK" | "ASCII">("ASCII");
  const [newlineMode, setNewlineMode] = useState<"None" | "CRLF" | "LF" | "CR">("None");
  const [sendText, setSendText] = useState("");
  const [sendFormatPinned, setSendFormatPinned] = useState(false);
  const [rxText, setRxText] = useState("等待串口数据...\n");
  const [pauseRx, setPauseRx] = useState(false);
  /** 开启：接收区带时间戳（默认）；关闭：仅按接收顺序追加原始内容 */
  const [rxShowTime, setRxShowTime] = useState(true);
  /** 开启：两次接收间隔较大时自动换行；关闭：不在块之间插入换行，除非对端数据里自带换行符 */
  const [rxAutoWrap, setRxAutoWrap] = useState(false);
  const rxShowTimeRef = useRef(true);
  const rxAutoWrapRef = useRef(false);
  const [pendingRxLines, setPendingRxLines] = useState<string[]>([]);
  const rxLastChunkTsRef = useRef<number | null>(null);
  const rxTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rxAutoFollowRef = useRef(true);
  const [rxFollowingLatest, setRxFollowingLatest] = useState(true);
  const [rxJumpBtnPos, setRxJumpBtnPos] = useState<{ visible: boolean; x: number; y: number }>({
    visible: false,
    x: 0,
    y: 0,
  });
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("就绪");
  const [homeQuickPanelOpen, setHomeQuickPanelOpen] = useState(false);
  const [homeQuickPanelWidth, setHomeQuickPanelWidth] = useState(() => {
    const raw = localStorage.getItem(QUICK_PANEL_WIDTH_KEY);
    const num = Number(raw);
    return Number.isFinite(num) ? Math.max(360, Math.min(560, num)) : 420;
  });
  const [chartKind, setChartKind] = useState<ChartKind>("line");
  const [chartWindow, setChartWindow] = useState<ChartWindow>(100);
  const [chartSource, setChartSource] = useState<ChartSource>("tx");
  const [chartExportFormat, setChartExportFormat] = useState<ChartExportFormat>("png");
  const [chartExportName, setChartExportName] = useState("quick-chart");
  const [chartPixelRatio, setChartPixelRatio] = useState(2);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const quickPanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [manualPort, setManualPort] = useState("");
  const [aliasInput, setAliasInput] = useState("");
  const [stats, setStats] = useState<IoStats>({ txBytes: 0, rxBytes: 0, txFrames: 0, rxFrames: 0 });
  const [logs, setLogs] = useState<Array<{ ts: number; dir: "RX" | "TX"; text: string }>>([]);
  const [configByPort, setConfigByPort] = useState<Record<string, PortConfigCache>>({});
  const [quickSends, setQuickSends] = useState<QuickSendItem[]>(() => {
    try {
      const raw = localStorage.getItem("uart.quickSends");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as QuickSendItem[];
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, 100).map((x) => ({
        id: String(x.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: String(x.name || ""),
        payload: String(x.payload || ""),
        format: x.format === "HEX" ? "HEX" : "ASCII",
      }));
    } catch {
      return [];
    }
  });

  // SCHED
  const [timerCycleEnabled, setTimerCycleEnabled] = useState(false);
  const [timerCycleMs, setTimerCycleMs] = useState(1000);
  const [timerRunning, setTimerRunning] = useState(false);
  const [seqText, setSeqText] = useState("AA55|HEX|200\nhello|ASCII|500");
  const [seqRunning, setSeqRunning] = useState(false);
  const [triggerKeyword, setTriggerKeyword] = useState("");
  const [triggerPayload, setTriggerPayload] = useState("");
  const [triggerFormat, setTriggerFormat] = useState<SendFormat>("ASCII");
  const [fileSendFormat, setFileSendFormat] = useState<FileSendFormat>("binary");
  const [fileToSend, setFileToSend] = useState<File | null>(null);
  const [fileSending, setFileSending] = useState(false);
  const [isWindowVerticalMaximized, setIsWindowVerticalMaximized] = useState(false);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const verticalWindowSnapshotRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [uiScale, setUiScale] = useState(1);

  // FILTER / MARK
  const [whitelist, setWhitelist] = useState("");
  const [blacklist, setBlacklist] = useState("");
  const [regexFilter, setRegexFilter] = useState("");
  const [highlightKeys, setHighlightKeys] = useState("error,ok,timeout");

  // CRC / PROTOCOL
  const [calcInput, setCalcInput] = useState("01 03 00 00 00 02");
  const [calcResult, setCalcResult] = useState("");
  const [modbusInput, setModbusInput] = useState("01 03 04 00 0A 00 14");
  const [modbusResult, setModbusResult] = useState("");
  const missingPortCountRef = useRef(0);

  const i18n: Record<Lang, Record<string, string>> = {
    "zh-CN": {
      home: "首页",
      quickSettings: "快捷设置",
      advanced: "高级功能",
      refreshPorts: "刷新端口",
      openPort: "打开串口",
      closePort: "关闭串口",
      recentConfig: "最近配置",
      serialParams: "串口参数",
      port: "端口",
      baudRate: "波特率",
      dataBits: "数据位",
      stopBits: "停止位",
      parity: "校验位",
      flowControl: "流控",
      dtr: "DTR",
      rts: "RTS",
      rxPanel: "日志区",
      clearRx: "清空接收",
      pauseRx: "暂停接收",
      resumeRx: "继续接收",
      txPlaceholder: "输入要发送的数据...",
      send: "发送",
      clearTx: "清空发送",
      clearStats: "清空统计",
      statusConnected: "状态：已连接",
      statusDisconnected: "状态：未连接",
      language: "界面语言",
      deviceSettings: "设备快捷设置",
      alias: "设备别名",
      saveAlias: "保存别名",
      setPreferred: "设为默认端口",
      encodingAuto: "编码: 自动",
      encodingUtf8: "编码: UTF-8",
      encodingGbk: "编码: GBK",
      encodingAscii: "编码: ASCII",
      theme: "主题",
      themeLight: "明主题 Light",
      themeDark: "暗主题 Dark",
      themeDemo: "主题实时预览",
      rxShowTime: "按时间显示",
      rxShowTimeHintOn: "开启：接收区带时间戳",
      rxShowTimeHintOff: "关闭：仅按顺序显示内容",
      rxAutoWrap: "自动换行",
      rxAutoWrapHintOn: "开启：接收不连续时自动换行",
      rxAutoWrapHintOff: "关闭：块之间不插换行，无 0D0A 则连续拼接",
    },
    "zh-TW": {
      home: "首頁",
      quickSettings: "快捷設定",
      advanced: "進階功能",
      refreshPorts: "刷新連接埠",
      openPort: "開啟串口",
      closePort: "關閉串口",
      recentConfig: "最近配置",
      serialParams: "串口參數",
      port: "連接埠",
      baudRate: "鮑率",
      dataBits: "資料位",
      stopBits: "停止位",
      parity: "校驗位",
      flowControl: "流控",
      dtr: "DTR",
      rts: "RTS",
      rxPanel: "日誌區",
      clearRx: "清空接收",
      pauseRx: "暫停接收",
      resumeRx: "繼續接收",
      txPlaceholder: "輸入要發送的資料...",
      send: "發送",
      clearTx: "清空發送",
      clearStats: "清空統計",
      statusConnected: "狀態：已連線",
      statusDisconnected: "狀態：未連線",
      language: "介面語言",
      deviceSettings: "設備快捷設定",
      alias: "設備別名",
      saveAlias: "保存別名",
      setPreferred: "設為預設連接埠",
      encodingAuto: "編碼: 自動",
      encodingUtf8: "編碼: UTF-8",
      encodingGbk: "編碼: GBK",
      encodingAscii: "編碼: ASCII",
      theme: "主題",
      themeLight: "明主題 Light",
      themeDark: "暗主題 Dark",
      themeDemo: "主題即時預覽",
      rxShowTime: "依時間顯示",
      rxShowTimeHintOn: "開啟：接收區含時間戳",
      rxShowTimeHintOff: "關閉：僅依序顯示內容",
      rxAutoWrap: "自動換行",
      rxAutoWrapHintOn: "開啟：接收不連續時自動換行",
      rxAutoWrapHintOff: "關閉：區塊間不換行，無 0D0A 則連續拼接",
    },
    en: {
      home: "Home",
      quickSettings: "Quick Settings",
      advanced: "Advanced",
      refreshPorts: "Refresh Ports",
      openPort: "Open Port",
      closePort: "Close Port",
      recentConfig: "Recent Config",
      serialParams: "Serial Parameters",
      port: "Port",
      baudRate: "Baud Rate",
      dataBits: "Data Bits",
      stopBits: "Stop Bits",
      parity: "Parity",
      flowControl: "Flow Control",
      dtr: "DTR",
      rts: "RTS",
      rxPanel: "Log",
      clearRx: "Clear RX",
      pauseRx: "Pause RX",
      resumeRx: "Resume RX",
      txPlaceholder: "Input payload...",
      send: "Send",
      clearTx: "Clear TX",
      clearStats: "Clear Stats",
      statusConnected: "Status: Connected",
      statusDisconnected: "Status: Disconnected",
      language: "Language",
      deviceSettings: "Device Quick Settings",
      alias: "Device Alias",
      saveAlias: "Save Alias",
      setPreferred: "Set Preferred Port",
      encodingAuto: "Encoding: Auto",
      encodingUtf8: "Encoding: UTF-8",
      encodingGbk: "Encoding: GBK",
      encodingAscii: "Encoding: ASCII",
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      themeDemo: "Live Theme Preview",
      rxShowTime: "Show timestamp",
      rxShowTimeHintOn: "On: RX lines include timestamp",
      rxShowTimeHintOff: "Off: append raw data in order only",
      rxAutoWrap: "Auto wrap",
      rxAutoWrapHintOn: "On: newline when RX is not continuous",
      rxAutoWrapHintOff: "Off: no extra newlines; stream until device sends CR/LF",
    },
    ja: {
      home: "ホーム",
      quickSettings: "クイック設定",
      advanced: "高度機能",
      refreshPorts: "ポート更新",
      openPort: "ポートを開く",
      closePort: "ポートを閉じる",
      recentConfig: "最近の設定",
      serialParams: "シリアル設定",
      port: "ポート",
      baudRate: "ボーレート",
      dataBits: "データビット",
      stopBits: "ストップビット",
      parity: "パリティ",
      flowControl: "フロー制御",
      dtr: "DTR",
      rts: "RTS",
      rxPanel: "ログ",
      clearRx: "受信クリア",
      pauseRx: "受信停止",
      resumeRx: "受信再開",
      txPlaceholder: "送信データを入力...",
      send: "送信",
      clearTx: "送信クリア",
      clearStats: "統計クリア",
      statusConnected: "状態：接続済み",
      statusDisconnected: "状態：未接続",
      language: "言語",
      deviceSettings: "デバイスクイック設定",
      alias: "デバイス別名",
      saveAlias: "別名を保存",
      setPreferred: "既定ポートに設定",
      encodingAuto: "文字コード: 自動",
      encodingUtf8: "文字コード: UTF-8",
      encodingGbk: "文字コード: GBK",
      encodingAscii: "文字コード: ASCII",
      theme: "テーマ",
      themeLight: "ライト",
      themeDark: "ダーク",
      themeDemo: "テーマプレビュー",
      rxShowTime: "時刻を表示",
      rxShowTimeHintOn: "オン：受信に時刻を付与",
      rxShowTimeHintOff: "オフ：受信順にそのまま表示",
      rxAutoWrap: "自動改行",
      rxAutoWrapHintOn: "オン：受信が途切れたら改行",
      rxAutoWrapHintOff: "オフ：区切りで改行しない（0D0A なら連結）",
    },
    de: {
      home: "Start",
      quickSettings: "Schnelleinstellungen",
      advanced: "Erweitert",
      refreshPorts: "Ports aktualisieren",
      openPort: "Port öffnen",
      closePort: "Port schließen",
      recentConfig: "Letzte Konfig",
      serialParams: "Serielle Parameter",
      port: "Port",
      baudRate: "Baudrate",
      dataBits: "Datenbits",
      stopBits: "Stoppbits",
      parity: "Parität",
      flowControl: "Flusskontrolle",
      dtr: "DTR",
      rts: "RTS",
      rxPanel: "Log",
      clearRx: "RX leeren",
      pauseRx: "RX pausieren",
      resumeRx: "RX fortsetzen",
      txPlaceholder: "Daten eingeben...",
      send: "Senden",
      clearTx: "TX leeren",
      clearStats: "Statistik löschen",
      statusConnected: "Status: Verbunden",
      statusDisconnected: "Status: Getrennt",
      language: "Sprache",
      deviceSettings: "Geräte-Schnelleinstellungen",
      alias: "Gerätealias",
      saveAlias: "Alias speichern",
      setPreferred: "Als Standardport setzen",
      encodingAuto: "Kodierung: Auto",
      encodingUtf8: "Kodierung: UTF-8",
      encodingGbk: "Kodierung: GBK",
      encodingAscii: "Kodierung: ASCII",
      theme: "Thema",
      themeLight: "Hell",
      themeDark: "Dunkel",
      themeDemo: "Live Vorschau",
      rxShowTime: "Zeit anzeigen",
      rxShowTimeHintOn: "Ein: Zeitstempel in RX",
      rxShowTimeHintOff: "Aus: nur Rohdaten der Reihe nach",
      rxAutoWrap: "Auto umbrechen",
      rxAutoWrapHintOn: "Ein: Zeilenumbruch bei RX-Pause",
      rxAutoWrapHintOff: "Aus: keine extra Zeilenumbrüche (stream)",
    },
  };
  const t = (k: string) => i18n[lang][k] ?? k;

  const [form, setForm] = useState<FormState>({
    port: "COM3",
    baudRate: "115200",
    dataBits: "8",
    stopBits: "1",
    parity: "None",
    flowControl: "None",
    dtr: false,
    rts: false,
  });

  /** 供定时 refreshPorts 读取最新值，避免 interval 闭包一直停留在首次渲染的 manualPort/form.port */
  const portSelectionRef = useRef({ manualPort: "", formPort: form.port });
  portSelectionRef.current = { manualPort, formPort: form.port };
  rxShowTimeRef.current = rxShowTime;
  rxAutoWrapRef.current = rxAutoWrap;

  const statusText = useMemo(() => {
    return serialOpen ? t("statusConnected") : t("statusDisconnected");
  }, [serialOpen, lang]);

  useEffect(() => {
    localStorage.setItem("uart.lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("uart.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("uart.quickSends", JSON.stringify(quickSends));
  }, [quickSends]);

  const baudOptions = [
    "200",
    "300",
    "600",
    "1200",
    "2400",
    "4800",
    "9600",
    "19200",
    "38400",
    "57600",
    "115200",
    "230400",
    "460800",
    "921600",
    "1000000",
    "2000000",
    "3000000",
    "4000000",
  ];

  const selectedPortInfo = useMemo(() => ports.find((p) => p.path === form.port), [ports, form.port]);
  const txHistory = useMemo(() => logs.filter((x) => x.dir === "TX"), [logs]);
  const txNumericHistory = useMemo(() => {
    return txHistory
      .map((x) => ({ ts: x.ts, text: x.text, value: extractFirstNumber(x.text) }))
      .filter((x) => x.value !== null)
      .map((x) => ({ ts: x.ts, text: x.text, value: x.value as number }));
  }, [txHistory]);
  const rxNumericHistory = useMemo(() => {
    return logs
      .filter((x) => x.dir === "RX")
      .map((x) => ({ ts: x.ts, text: x.text, value: extractFirstNumber(x.text) }))
      .filter((x) => x.value !== null)
      .map((x) => ({ ts: x.ts, text: x.text, value: x.value as number }));
  }, [logs]);
  const txNumericWindowed = useMemo(() => (chartWindow === "all" ? txNumericHistory : txNumericHistory.slice(0, chartWindow)), [txNumericHistory, chartWindow]);
  const rxNumericWindowed = useMemo(() => (chartWindow === "all" ? rxNumericHistory : rxNumericHistory.slice(0, chartWindow)), [rxNumericHistory, chartWindow]);
  const chartStats = useMemo(() => {
    const values =
      chartSource === "tx"
        ? txNumericWindowed.map((x) => x.value)
        : chartSource === "rx"
          ? rxNumericWindowed.map((x) => x.value)
          : [...txNumericWindowed.map((x) => x.value), ...rxNumericWindowed.map((x) => x.value)];
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const latest = values[0];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { min, max, latest, avg, count: values.length };
  }, [chartSource, txNumericWindowed, rxNumericWindowed]);

  const applyRecent = async () => {
    try {
      const cache = await invoke<SerialConfigCachePayload>("serial_get_config_cache");
      const byPortRaw = cache.byPort ?? {};
      const byPort: Record<string, PortConfigCache> = {};
      Object.entries(byPortRaw).forEach(([port, cfg]) => {
        byPort[port] = {
          baudRate: String(cfg.baudRate),
          dataBits: String(cfg.dataBits),
          stopBits: cfg.stopBits,
          parity: cfg.parity,
          flowControl: cfg.flowControl,
          dtr: cfg.dtr,
          rts: cfg.rts,
        };
      });
      setConfigByPort(byPort);
      const c = cache.lastOpened;
      if (c?.port) {
        setManualPort(c.port);
        setForm({
          port: c.port,
          baudRate: String(c.baudRate),
          dataBits: String(c.dataBits),
          stopBits: c.stopBits,
          parity: c.parity,
          flowControl: c.flowControl,
          dtr: c.dtr,
          rts: c.rts,
        });
        setStatusMsg("已加载上次打开配置");
        return;
      }
    } catch {
      // ignore cache read error, fallback to backend recent
    }
    try {
      const list = await invoke<SerialConfig[]>("serial_get_recent_configs");
      if (list.length === 0) return;
      const c = list[0];
      setForm({
        port: c.port,
        baudRate: String(c.baudRate),
        dataBits: String(c.dataBits),
        stopBits: c.stopBits,
        parity: c.parity,
        flowControl: c.flowControl,
        dtr: c.dtr,
        rts: c.rts,
      });
      setStatusMsg("已加载最近配置");
    } catch {
      setStatusMsg("读取最近配置失败");
    }
  };

  const refreshPorts = async () => {
    try {
      const list = await invoke<PortInfo[]>("serial_scan_ports");
      setPorts(list);
      const { manualPort: mp, formPort: fp } = portSelectionRef.current;
      const preferredPort = list.find((p) => p.preferred)?.path;
      const hasCurrent = list.some((p) => p.path === fp);
      const hasManualInList = mp ? list.some((p) => p.path === mp) : false;

      if (mp) {
        // 用户已从下拉框选过端口：不因扫描抖动改回 preferred，仅当列表里能匹配时再对齐
        missingPortCountRef.current = 0;
        if (hasManualInList && fp !== mp) {
          setForm((prev) => ({ ...prev, port: mp }));
        }
      } else if (hasCurrent) {
        missingPortCountRef.current = 0;
      } else if (list.length > 0) {
        missingPortCountRef.current += 1;
        if (missingPortCountRef.current >= 3) {
          setForm((prev) => ({ ...prev, port: preferredPort ?? list[0].path }));
          missingPortCountRef.current = 0;
        }
      }
      setStatusMsg(`已刷新端口，共 ${list.length} 个`);
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "刷新端口失败");
    }
  };

  const refreshProfiles = async () => {
    try {
      await invoke<DeviceProfile[]>("serial_get_device_profiles");
    } catch {
      // ignore for now
    }
  };

  const openSerial = async () => {
    setBusy(true);
    try {
      // 打开前先重新扫描一次，避免使用到已失效的缓存端口（常见报错：系统找不到指定文件）
      const latestPorts = await invoke<PortInfo[]>("serial_scan_ports");
      setPorts(latestPorts);
      const exists = latestPorts.some((p) => p.path === form.port);
      if (!exists) {
        setStatusMsg(`端口 ${form.port} 不存在，请重新选择后再打开`);
        return;
      }

      const cfg: SerialConfig = {
        port: form.port,
        baudRate: Number(form.baudRate),
        dataBits: Number(form.dataBits),
        stopBits: form.stopBits,
        parity: form.parity,
        flowControl: form.flowControl,
        dtr: form.dtr,
        rts: form.rts,
      };
      await invoke("serial_validate_config", { config: cfg });
      await invoke("serial_open", { config: cfg });
      const nextPortCfg: PortConfigCache = {
        baudRate: String(cfg.baudRate),
        dataBits: String(cfg.dataBits),
        stopBits: cfg.stopBits,
        parity: cfg.parity,
        flowControl: cfg.flowControl,
        dtr: cfg.dtr,
        rts: cfg.rts,
      };
      const nextByPort = { ...configByPort, [cfg.port]: nextPortCfg };
      setConfigByPort(nextByPort);
      const byPortRaw: Record<string, PortConfigCacheEntryRaw> = {};
      Object.entries(nextByPort).forEach(([port, item]) => {
        byPortRaw[port] = {
          baudRate: Number(item.baudRate),
          dataBits: Number(item.dataBits),
          stopBits: item.stopBits,
          parity: item.parity,
          flowControl: item.flowControl,
          dtr: item.dtr,
          rts: item.rts,
        };
      });
      await invoke("serial_save_config_cache", {
        cache: {
          lastOpened: cfg,
          byPort: byPortRaw,
        } satisfies SerialConfigCachePayload,
      });
      setSerialOpen(true);
      setStatusMsg("串口已打开");
    } catch (e) {
      const err = e as ApiError;
      if ((err.message || "").includes("系统找不到指定文件")) {
        setStatusMsg(`端口 ${form.port} 可能已断开或变更，请刷新并重新选择`);
      } else {
        setStatusMsg(err.message || "打开串口失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const closeSerial = async () => {
    try {
      await invoke("serial_close");
      setSerialOpen(false);
      setStatusMsg("串口已关闭");
    } catch {
      setStatusMsg("关闭串口失败");
    }
  };

  const updateLineState = async (nextDtr: boolean, nextRts: boolean) => {
    setForm((prev) => ({ ...prev, dtr: nextDtr, rts: nextRts }));
    if (!serialOpen) return;
    try {
      await invoke("serial_set_line_state", { dtr: nextDtr, rts: nextRts });
      setStatusMsg("DTR/RTS 已更新");
    } catch {
      setStatusMsg("DTR/RTS 更新失败");
    }
  };

  const sendPayload = async (override?: { payload?: string; format?: SendFormat }) => {
    const payload = override?.payload ?? sendText;
    const format = override?.format ?? sendFormat;
    if (!serialOpen) {
      setStatusMsg("请先打开串口");
      return;
    }
    if (!payload.trim()) {
      setStatusMsg("发送内容为空");
      return;
    }
    try {
      const method = format === "HEX" ? "serial_send_hex" : "serial_send_ascii";
      const next = await invoke<IoStats>(method, {
        payload,
        newlineMode,
      });
      setStats(next);
      setLogs((prev) => [{ ts: Date.now(), dir: "TX" as const, text: payload }, ...prev].slice(0, 5000));
      const nowTs = Date.now();
      const txLine = rxShowTimeRef.current ? `[${formatTime(nowTs)}] [TX] ${payload}` : `[TX] ${payload}`;
      const prevTs = rxLastChunkTsRef.current;
      const gapLarge = prevTs !== null && nowTs - prevTs > RX_GAP_WRAP_MS;
      rxLastChunkTsRef.current = nowTs;
      if (rxAutoWrapRef.current) {
        setRxText((prev) => `${prev}${gapLarge ? "\n" : ""}${txLine}\n`);
      } else {
        setRxText((prev) => `${prev}${txLine}`);
      }
      setStatusMsg(`发送成功 (${format})`);
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "发送失败");
    }
  };

  const handleSendToggle = () => {
    if (!timerCycleEnabled) {
      void sendPayload();
      return;
    }
    setTimerRunning((v) => !v);
  };

  const handleSendFormatSwitch = (next: SendFormat, pinByUser = true) => {
    if (next === sendFormat) return;
    if (pinByUser) setSendFormatPinned(true);
    const raw = sendText;
    if (!raw.trim()) {
      setSendFormat(next);
      return;
    }
    if (next === "HEX") {
      const bytes = Array.from(new TextEncoder().encode(raw));
      setSendText(formatBytes(bytes, "HEX"));
      setSendFormat("HEX");
      setStatusMsg("已将发送内容从 ASCII 转为 HEX");
      return;
    }
    const bytes = parseHexString(raw);
    if (bytes.length === 0) {
      setStatusMsg("HEX 内容无效，无法转换为 ASCII");
      return;
    }
    const decoded = decodeBytesWithEncoding(bytes, "utf-8");
    setSendText(decoded.text);
    setSendFormat("ASCII");
    setStatusMsg("已将发送内容从 HEX 转为 ASCII");
  };

  const handleSendPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!sendFormatPinned && sendFormat !== "HEX" && shouldPreferHexByPastedText(pasted)) {
      setSendFormat("HEX");
      setStatusMsg("检测到粘贴内容更像 HEX，已自动切换到 HEX");
    }
  };

  const clearRx = () => {
    setRxText("");
    setPendingRxLines([]);
    rxLastChunkTsRef.current = null;
    rxAutoFollowRef.current = true;
    setRxFollowingLatest(true);
    setRxJumpBtnPos((prev) => ({ ...prev, visible: false }));
    setStatusMsg("已清空接收区");
  };

  const handleRxScroll = () => {
    const el = rxTextareaRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    rxAutoFollowRef.current = nearBottom;
    setRxFollowingLatest(nearBottom);
    if (nearBottom) {
      setRxJumpBtnPos((prev) => ({ ...prev, visible: false }));
    }
  };

  const scrollRxToLatest = () => {
    const el = rxTextareaRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    rxAutoFollowRef.current = true;
    setRxFollowingLatest(true);
    setRxJumpBtnPos((prev) => ({ ...prev, visible: false }));
    setStatusMsg("已回到最新接收");
  };

  const handleRxMouseDown = (e: MouseEvent<HTMLTextAreaElement>) => {
    if (rxFollowingLatest) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hitScrollbar = e.clientX >= rect.right - 20;
    if (!hitScrollbar) return;
    setRxJumpBtnPos({
      visible: true,
      x: Math.max(12, e.clientX - 86),
      y: Math.max(12, e.clientY - 14),
    });
  };

  const clearTx = () => {
    setSendText("");
    setStatusMsg("已清空发送区");
  };

  const clearStats = async () => {
    try {
      const next = await invoke<IoStats>("serial_reset_stats");
      setStats(next);
      setStatusMsg("已清空统计");
    } catch {
      setStatusMsg("清空统计失败");
    }
  };

  const sendFile = async () => {
    if (!fileToSend) {
      setStatusMsg("请先选择文件");
      return;
    }
    if (fileSending) return;
    setFileSending(true);
    try {
      if (fileSendFormat === "binary") {
        const buffer = await fileToSend.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        await sendPayload({ payload: formatBytes(bytes, "HEX"), format: "HEX" });
        setStatusMsg(`文件发送完成(binary): ${fileToSend.name}`);
      } else if (fileSendFormat === "ascii") {
        const text = await fileToSend.text();
        await sendPayload({ payload: text, format: "ASCII" });
        setStatusMsg(`文件发送完成(ascii): ${fileToSend.name}`);
      } else if (fileSendFormat === "hex") {
        const text = await fileToSend.text();
        const bytes = parseHexString(text);
        if (bytes.length === 0) {
          setStatusMsg("HEX 文件内容无效（需为偶数字节HEX）");
          return;
        }
        await sendPayload({ payload: formatBytes(bytes, "HEX"), format: "HEX" });
        setStatusMsg(`文件发送完成(hex): ${fileToSend.name}`);
      } else {
        setStatusMsg(`${fileSendFormat} 发送协议待开发（下一阶段实现）`);
      }
    } catch {
      setStatusMsg("文件发送失败");
    } finally {
      setFileSending(false);
    }
  };

  const addQuickSend = () => {
    setQuickSends((prev) => {
      if (prev.length >= 100) return prev;
      return [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: `快捷发送${prev.length + 1}`,
          payload: "",
          format: "ASCII",
        },
      ];
    });
  };

  const updateQuickSend = (id: string, patch: Partial<QuickSendItem>) => {
    setQuickSends((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  const removeQuickSend = (id: string) => {
    setQuickSends((prev) => prev.filter((x) => x.id !== id));
  };

  const handlePortSelect = (port: string) => {
    setManualPort(port);
    missingPortCountRef.current = 0;
    const cachedByPort = configByPort[port];
    if (cachedByPort) {
      setForm((prev) => ({ ...prev, port, ...cachedByPort }));
      setStatusMsg("已自动带出该端口上次配置");
      return;
    }
    setForm((prev) => ({ ...prev, port }));
  };

  const passFilter = (line: string): boolean => {
    const w = whitelist.trim();
    if (w && !line.includes(w)) return false;
    const b = blacklist.trim();
    if (b && line.includes(b)) return false;
    const r = regexFilter.trim();
    if (r) {
      try {
        if (!new RegExp(r).test(line)) return false;
      } catch {
        // ignore invalid regex
      }
    }
    return true;
  };

  const applyHighlight = (line: string): string => {
    const keys = highlightKeys
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    let out = line;
    keys.forEach((k) => {
      const reg = new RegExp(k, "ig");
      out = out.replace(reg, (m) => `【${m}】`);
    });
    return out;
  };

  const saveDeviceProfile = async (setPreferredPort: boolean) => {
    if (!selectedPortInfo) {
      setStatusMsg("请先选择设备");
      return;
    }
    try {
      await invoke("serial_set_device_profile", {
        deviceKey: selectedPortInfo.deviceKey,
        alias: aliasInput || null,
        preferredPort: setPreferredPort ? selectedPortInfo.path : null,
      });
      setStatusMsg(setPreferredPort ? "已保存别名并设为默认端口" : "已保存设备别名");
      await refreshProfiles();
      await refreshPorts();
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "保存设备配置失败");
    }
  };

  useEffect(() => {
    void refreshPorts();
    void refreshProfiles();
    void applyRecent();
    const timer = setInterval(() => {
      void refreshPorts();
    }, 3000);
    const unlistenPromise = listen<StatusEvent>("serial://status", (event) => {
      setSerialOpen(event.payload.connected);
      setStatusMsg(event.payload.message);
    });
    return () => {
      clearInterval(timer);
      void unlistenPromise.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPortInfo) {
      setAliasInput("");
      return;
    }
    setAliasInput(selectedPortInfo.alias ?? "");
  }, [selectedPortInfo]);

  useEffect(() => {
    const updateScale = () => {
      const ratioW = window.innerWidth / BASE_VIEWPORT_WIDTH;
      const ratioH = window.innerHeight / BASE_VIEWPORT_HEIGHT;
      // 以“首屏完整可见”为优先，允许缩小到更低倍率，避免首页被裁切
      const next = Math.max(0.55, Math.min(1.35, Math.min(ratioW, ratioH)));
      setUiScale(next);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  useEffect(() => {
    if (serialOpen) {
      rxLastChunkTsRef.current = null;
    }
  }, [serialOpen]);

  useEffect(() => {
    if (!serialOpen) return;
    const timer = setInterval(async () => {
      try {
        const chunk = await invoke<RxChunk>("serial_read_available");
        setStats(chunk.stats);
        if (chunk.bytes.length === 0) return;
        let payload = formatBytes(chunk.bytes, rxFormat);
        if (rxFormat === "ASCII") {
          const decoded = decodeBytesWithEncoding(chunk.bytes, encodingMode);
          payload = decoded.text || formatBytes(chunk.bytes, "ASCII");
          setActiveEncoding(decoded.usedEncoding);
        }
        const rawLine = rxShowTime ? `[${formatTime(chunk.timestampMs)}] ${payload}` : payload;
        setLogs((prev) => [{ ts: Date.now(), dir: "RX" as const, text: rawLine }, ...prev].slice(0, 5000));

        if (triggerKeyword.trim() && rawLine.includes(triggerKeyword.trim()) && triggerPayload.trim()) {
          void sendPayload({ payload: triggerPayload, format: triggerFormat });
        }
        const ts = Number(chunk.timestampMs);
        const prevTs = rxLastChunkTsRef.current;
        const gapLarge = prevTs !== null && ts - prevTs > RX_GAP_WRAP_MS;
        rxLastChunkTsRef.current = ts;
        if (!passFilter(rawLine)) return;
        const line = applyHighlight(rawLine);
        if (pauseRx) {
          setPendingRxLines((prev) => {
            const next = [...prev, line];
            return next.length > 200 ? next.slice(next.length - 200) : next;
          });
        } else if (rxAutoWrap) {
          setRxText((prev) => `${prev}${gapLarge ? "\n" : ""}${line}\n`);
        } else {
          setRxText((prev) => `${prev}${line}`);
        }
      } catch {
        // ignore transient read failures
      }
    }, 160);
    return () => clearInterval(timer);
  }, [serialOpen, pauseRx, rxFormat, encodingMode, rxShowTime, rxAutoWrap]);

  useEffect(() => {
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    const persistWindowBounds = async () => {
      try {
        const pos = await appWindow.outerPosition();
        const size = await appWindow.outerSize();
        localStorage.setItem(
          WINDOW_BOUNDS_CACHE_KEY,
          JSON.stringify({ x: pos.x, y: pos.y, width: size.width, height: size.height }),
        );
      } catch {
        // ignore
      }
    };

    const restoreWindowBounds = async () => {
      try {
        const raw = localStorage.getItem(WINDOW_BOUNDS_CACHE_KEY);
        if (raw) {
          const b = JSON.parse(raw) as { x: number; y: number; width: number; height: number };
          if (b?.width > 0 && b?.height > 0) {
            await appWindow.setPosition(new PhysicalPosition(b.x, b.y));
            await appWindow.setSize(new PhysicalSize(b.width, b.height));
          }
        } else {
          // 首次启动：默认占屏幕四分之一（宽高各 1/2）
          const monitor = await currentMonitor();
          if (monitor) {
            const w = Math.floor(monitor.workArea.size.width / 2);
            const h = Math.floor(monitor.workArea.size.height / 2);
            const x = monitor.workArea.position.x + Math.floor((monitor.workArea.size.width - w) / 2);
            const y = monitor.workArea.position.y + Math.floor((monitor.workArea.size.height - h) / 2);
            await appWindow.setPosition(new PhysicalPosition(x, y));
            await appWindow.setSize(new PhysicalSize(w, h));
            await persistWindowBounds();
          }
        }
      } catch {
        // ignore
      }
    };

    const bindWindowState = async () => {
      try {
        await restoreWindowBounds();
        setIsWindowFullscreen(await appWindow.isFullscreen());
        unlistenResized = await appWindow.onResized(async () => {
          setIsWindowFullscreen(await appWindow.isFullscreen());
          await persistWindowBounds();
        });
        unlistenMoved = await appWindow.onMoved(async () => {
          await persistWindowBounds();
        });
      } catch {
        // ignore non-desktop runtimes
      }
    };
    void bindWindowState();
    return () => {
      if (unlistenResized) unlistenResized();
      if (unlistenMoved) unlistenMoved();
    };
  }, [appWindow]);

  useEffect(() => {
    localStorage.setItem(QUICK_PANEL_WIDTH_KEY, String(homeQuickPanelWidth));
  }, [homeQuickPanelWidth]);

  useEffect(() => {
    const onMouseMove = (e: globalThis.MouseEvent) => {
      const drag = quickPanelResizeRef.current;
      if (!drag) return;
      const delta = drag.startX - e.clientX;
      const next = Math.max(360, Math.min(560, drag.startWidth + delta));
      setHomeQuickPanelWidth(next);
    };
    const onMouseUp = () => {
      quickPanelResizeRef.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const startQuickPanelResize = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    quickPanelResizeRef.current = { startX: e.clientX, startWidth: homeQuickPanelWidth };
  };

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el || !homeQuickPanelOpen) return;
    const inst = echarts.init(el);
    chartInstanceRef.current = inst;
    return () => {
      inst.dispose();
      chartInstanceRef.current = null;
    };
  }, [homeQuickPanelOpen]);

  useEffect(() => {
    const inst = chartInstanceRef.current;
    if (!inst || !homeQuickPanelOpen) return;
    const txPoints = txNumericWindowed.slice().reverse();
    const rxPoints = rxNumericWindowed.slice().reverse();
    const points = chartSource === "tx" ? txPoints : chartSource === "rx" ? rxPoints : txPoints;
    const xData = points.map((x) => formatTime(x.ts));
    const series: any[] = [];
    if (chartSource === "tx" || chartSource === "both") {
      series.push({
        name: "TX",
        type: chartKind,
        data: txPoints.map((x) => x.value),
        smooth: chartKind === "line",
        itemStyle: { color: "#0a84ff" },
        lineStyle: { color: "#0a84ff" },
        showSymbol: chartKind !== "line" || txPoints.length < 80,
      });
    }
    if (chartSource === "rx") {
      series.push({
        name: "RX",
        type: chartKind,
        data: rxPoints.map((x) => x.value),
        smooth: chartKind === "line",
        itemStyle: { color: "#34c759" },
        lineStyle: { color: "#34c759" },
        showSymbol: chartKind !== "line" || rxPoints.length < 80,
      });
    } else if (chartSource === "both") {
      series.push({
        name: "RX",
        type: chartKind,
        data: rxPoints.map((x) => x.value),
        smooth: chartKind === "line",
        itemStyle: { color: "#34c759" },
        lineStyle: { color: "#34c759" },
        showSymbol: chartKind !== "line" || rxPoints.length < 80,
      });
    }
    inst.setOption({
      animation: false,
      backgroundColor: "transparent",
      title: {
        text: "发送数值图",
        left: 8,
        textStyle: { color: theme === "dark" ? "#ececf1" : "#2c2c2e", fontSize: 12 },
      },
      tooltip: { trigger: "axis" },
      legend: { top: 8, right: 8, textStyle: { color: theme === "dark" ? "#b0b0ba" : "#636366" } },
      grid: { left: 36, right: 10, top: 30, bottom: 34 },
      xAxis: {
        type: "category",
        data: xData,
        axisLabel: { color: theme === "dark" ? "#b0b0ba" : "#636366", hideOverlap: true },
      },
      yAxis: { type: "value", axisLabel: { color: theme === "dark" ? "#b0b0ba" : "#636366" } },
      series,
      dataZoom: [
        { type: "inside", start: 0, end: 100 },
        { type: "slider", start: 0, end: 100, bottom: 4, height: 12 },
      ],
    });
    inst.resize();
  }, [chartKind, chartWindow, chartSource, txNumericWindowed, rxNumericWindowed, homeQuickPanelOpen, homeQuickPanelWidth, theme]);

  const exportQuickChart = async () => {
    const inst = chartInstanceRef.current;
    if (!inst) {
      setStatusMsg("图表未就绪");
      return;
    }
    const ts = Date.now();
    const baseName = (chartExportName || "quick-chart").trim() || "quick-chart";
    try {
      if (chartExportFormat === "svg") {
        const dataUrl = inst.getDataURL({ type: "svg", pixelRatio: chartPixelRatio, backgroundColor: "#fff" });
        const svgText = decodeURIComponent(dataUrl.replace("data:image/svg+xml;charset=UTF-8,", ""));
        downloadBlob(new Blob([svgText], { type: "image/svg+xml" }), `${baseName}-${ts}.svg`);
      } else if (chartExportFormat === "png" || chartExportFormat === "jpg") {
        const dataUrl = inst.getDataURL({
          type: chartExportFormat === "jpg" ? "jpeg" : "png",
          pixelRatio: chartPixelRatio,
          backgroundColor: "#fff",
        });
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${baseName}-${ts}.${chartExportFormat === "jpg" ? "jpg" : "png"}`;
        a.click();
      } else if (chartExportFormat === "pdf") {
        const dataUrl = inst.getDataURL({ type: "png", pixelRatio: chartPixelRatio, backgroundColor: "#fff" });
        const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();
        pdf.addImage(dataUrl, "PNG", 24, 24, pageW - 48, pageH - 48);
        pdf.save(`${baseName}-${ts}.pdf`);
      } else if (chartExportFormat === "bmp") {
        const dataUrl = inst.getDataURL({ type: "png", pixelRatio: chartPixelRatio, backgroundColor: "#fff" });
        const imageData = await dataUrlToImageData(dataUrl);
        const blob = imageDataToBmpBlob(imageData);
        downloadBlob(blob, `${baseName}-${ts}.bmp`);
      }
      setStatusMsg(`图表已另存为 ${chartExportFormat.toUpperCase()}`);
    } catch {
      setStatusMsg("图表导出失败");
    }
  };

  const minimizeWindow = async () => {
    try {
      await appWindow.minimize();
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "最小化失败");
    }
  };

  const toggleVerticalMaximizeWindow = async () => {
    try {
      if (isWindowVerticalMaximized && verticalWindowSnapshotRef.current) {
        const prev = verticalWindowSnapshotRef.current;
        await appWindow.setPosition(new PhysicalPosition(prev.x, prev.y));
        await appWindow.setSize(new PhysicalSize(prev.width, prev.height));
        setIsWindowVerticalMaximized(false);
      } else {
        const monitor = await currentMonitor();
        if (!monitor) throw new Error("无法获取显示器信息");
        const pos = await appWindow.outerPosition();
        const size = await appWindow.outerSize();
        verticalWindowSnapshotRef.current = { x: pos.x, y: pos.y, width: size.width, height: size.height };
        const nextY = monitor.workArea.position.y;
        const nextHeight = monitor.workArea.size.height;
        await appWindow.setPosition(new PhysicalPosition(pos.x, nextY));
        await appWindow.setSize(new PhysicalSize(size.width, nextHeight));
        setIsWindowVerticalMaximized(true);
      }
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "竖向最大化失败");
    }
  };

  const toggleFullscreenWindow = async () => {
    try {
      const next = !(await appWindow.isFullscreen());
      await appWindow.setFullscreen(next);
      setIsWindowFullscreen(next);
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "切换全屏失败");
    }
  };

  const closeWindow = async () => {
    try {
      await appWindow.close();
    } catch {
      // ignore
    }
  };

  const startCornerResize = async (direction: ResizeDirection) => {
    try {
      await appWindow.startResizeDragging(direction);
    } catch (e) {
      const err = e as ApiError;
      setStatusMsg(err.message || "窗口缩放失败");
    }
  };

  useEffect(() => {
    if (!timerRunning) return;
    // 点击启动后立即发送一次，然后按循环周期持续发送
    void sendPayload();
    const timer = setInterval(() => {
      void sendPayload();
    }, Math.max(1, timerCycleMs));
    return () => clearInterval(timer);
  }, [timerRunning, timerCycleMs]);

  useEffect(() => {
    if (!timerCycleEnabled && timerRunning) {
      setTimerRunning(false);
    }
  }, [timerCycleEnabled, timerRunning]);

  useEffect(() => {
    if (!seqRunning) return;
    let stopped = false;
    const run = async () => {
      const items = seqText
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      for (const line of items) {
        if (stopped) break;
        const [payload = "", fmt = "ASCII", delay = "200"] = line.split("|");
        await sendPayload({ payload, format: (fmt.toUpperCase() === "HEX" ? "HEX" : "ASCII") as SendFormat });
        await new Promise((r) => setTimeout(r, Math.max(1, Number(delay) || 200)));
      }
      if (!stopped) setSeqRunning(false);
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [seqRunning, seqText]);

  useEffect(() => {
    if (pauseRx || pendingRxLines.length === 0) return;
    const sep = rxAutoWrap ? "\n" : "";
    const tail = rxAutoWrap ? "\n" : "";
    setRxText((prev) => `${prev}${pendingRxLines.join(sep)}${tail}`);
    setPendingRxLines([]);
  }, [pauseRx, pendingRxLines, rxAutoWrap]);

  useEffect(() => {
    if (!rxAutoFollowRef.current) return;
    const el = rxTextareaRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rxText]);

  const exportLogs = (format: "txt" | "csv" | "json") => {
    let content = "";
    if (format === "json") {
      content = JSON.stringify(logs, null, 2);
    } else if (format === "csv") {
      content = "timestamp,direction,text\n" +
        logs
          .map((l) => `${new Date(l.ts).toISOString()},${l.dir},"${l.text.replace(/"/g, '""')}"`)
          .join("\n");
    } else {
      content = logs.map((l) => `[${new Date(l.ts).toISOString()}][${l.dir}] ${l.text}`).join("\n");
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uart-log.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onPlaybackFile = async (file?: File | null) => {
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    setStatusMsg(`开始回放，共 ${lines.length} 行`);
    for (const line of lines) {
      setRxText((prev) => `${prev}[REPLAY] ${line}\n`);
      await new Promise((r) => setTimeout(r, 80));
    }
    setStatusMsg("日志回放完成");
  };

  const runCrcCalc = () => {
    const bytes = parseHexString(calcInput);
    if (bytes.length === 0) {
      setCalcResult("输入无效，请填 HEX（偶数位）");
      return;
    }
    const crc16 = crc16Modbus(bytes).toString(16).toUpperCase().padStart(4, "0");
    const crc32 = crc32Simple(bytes).toString(16).toUpperCase().padStart(8, "0");
    setCalcResult(`CRC16(Modbus): 0x${crc16} | CRC32: 0x${crc32}`);
  };

  const runModbusParse = () => {
    const b = parseHexString(modbusInput);
    if (b.length < 4) {
      setModbusResult("帧太短");
      return;
    }
    const addr = b[0];
    const fn = b[1];
    const len = b[2];
    const data = b.slice(3, 3 + len);
    setModbusResult(`地址:${addr} 功能码:${fn} 数据长度:${len} 数据:[${data.join(", ")}]`);
  };

  const appStyle: CSSProperties = { zoom: uiScale };

  return (
    <div className={`app theme-${theme}`} style={appStyle}>
      <div className="resize-handle corner-nw" onMouseDown={() => void startCornerResize("NorthWest")} />
      <div className="resize-handle corner-ne" onMouseDown={() => void startCornerResize("NorthEast")} />
      <div className="resize-handle corner-sw" onMouseDown={() => void startCornerResize("SouthWest")} />
      <div className="resize-handle corner-se" onMouseDown={() => void startCornerResize("SouthEast")} />
      <header className="toolbar" data-tauri-drag-region>
        <div className="toolbar-left">
          <button type="button" onClick={refreshPorts}>
            {t("refreshPorts")}
          </button>
          <button
            type="button"
            className={serialOpen ? "serial-switch is-on" : "serial-switch is-off"}
            onClick={serialOpen ? closeSerial : openSerial}
            disabled={busy}
            aria-pressed={serialOpen}
            title={serialOpen ? t("closePort") : t("openPort")}
          >
            <span className="serial-switch-led" aria-hidden="true" />
            <span className="serial-switch-text">{serialOpen ? t("closePort") : t("openPort")}</span>
          </button>
          <button type="button" onClick={applyRecent}>
            {t("recentConfig")}
          </button>
        </div>
        <div className="toolbar-title">UART Tools (React + Tauri)</div>
        <div className="toolbar-tabs">
          <button
            type="button"
            className={activeTab === "home" ? "tab-btn active" : "tab-btn"}
            onClick={() => setActiveTab("home")}
          >
            {t("home")}
          </button>
          <button
            type="button"
            className={activeTab === "quick-settings" ? "tab-btn active" : "tab-btn"}
            onClick={() => setActiveTab("quick-settings")}
          >
            {t("quickSettings")}
          </button>
          <button
            type="button"
            className={activeTab === "advanced" ? "tab-btn active" : "tab-btn"}
            onClick={() => setActiveTab("advanced")}
          >
            {t("advanced")}
          </button>
        </div>
        <div className="window-controls">
          <button type="button" className="window-btn" onClick={() => void minimizeWindow()} title="最小化">
            -
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={() => void toggleVerticalMaximizeWindow()}
            title={isWindowVerticalMaximized ? "恢复窗口高度" : "上下撑满"}
          >
            {isWindowVerticalMaximized ? "⇵" : "↕"}
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={() => void toggleFullscreenWindow()}
            title={isWindowFullscreen ? "退出全屏" : "全屏显示"}
          >
            {isWindowFullscreen ? "⤢" : "⛶"}
          </button>
          <button type="button" className="window-btn close" onClick={() => void closeWindow()} title="关闭">
            ×
          </button>
        </div>
      </header>

      {activeTab === "home" ? (
        <>
        <section className="content">
        <aside className="left-panel">
          <h3>{t("serialParams")}</h3>
          <label>
            {t("port")}
            <select
              value={form.port}
              onChange={(e) => handlePortSelect(e.target.value)}
            >
              {ports.length === 0 ? (
                <option value={form.port}>{form.port || "无可用端口"}</option>
              ) : (
                ports.map((p) => (
                  <option key={p.id} value={p.path}>
                    {p.path} - {p.alias || p.friendlyName}
                    {p.preferred ? " (默认)" : ""}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            {t("baudRate")}
            <select
              value={form.baudRate}
              onChange={(e) => setForm((prev) => ({ ...prev, baudRate: e.target.value }))}
            >
              {baudOptions.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t("dataBits")}
            <select
              value={form.dataBits}
              onChange={(e) => setForm((prev) => ({ ...prev, dataBits: e.target.value }))}
            >
              <option>5</option>
              <option>6</option>
              <option>7</option>
              <option>8</option>
            </select>
          </label>

          <label>
            {t("stopBits")}
            <select
              value={form.stopBits}
              onChange={(e) => setForm((prev) => ({ ...prev, stopBits: e.target.value }))}
            >
              <option>1</option>
              <option>1.5</option>
              <option>2</option>
            </select>
          </label>

          <label>
            {t("parity")}
            <select
              value={form.parity}
              onChange={(e) => setForm((prev) => ({ ...prev, parity: e.target.value }))}
            >
              <option>None</option>
              <option>Odd</option>
              <option>Even</option>
              <option>Mark</option>
              <option>Space</option>
            </select>
          </label>

          <label>
            {t("flowControl")}
            <select
              value={form.flowControl}
              onChange={(e) => setForm((prev) => ({ ...prev, flowControl: e.target.value }))}
            >
              <option>None</option>
              <option>RTS/CTS</option>
              <option>XON/XOFF</option>
            </select>
          </label>
          <label className="line-state">
            <input
              type="checkbox"
              checked={form.dtr}
              onChange={(e) => updateLineState(e.target.checked, form.rts)}
            />
            {t("dtr")}
          </label>
          <label className="line-state">
            <input
              type="checkbox"
              checked={form.rts}
              onChange={(e) => updateLineState(form.dtr, e.target.checked)}
            />
            {t("rts")}
          </label>
          <button
            type="button"
            className={rxShowTime ? "serial-switch is-on rx-time-toggle" : "serial-switch is-off rx-time-toggle"}
            onClick={() => setRxShowTime((v) => !v)}
            aria-pressed={rxShowTime}
            title={rxShowTime ? t("rxShowTimeHintOn") : t("rxShowTimeHintOff")}
          >
            <span className="serial-switch-led" aria-hidden="true" />
            <span className="serial-switch-text">{t("rxShowTime")}</span>
          </button>
          <button
            type="button"
            className={rxAutoWrap ? "serial-switch is-on rx-wrap-toggle" : "serial-switch is-off rx-wrap-toggle"}
            onClick={() => setRxAutoWrap((v) => !v)}
            aria-pressed={rxAutoWrap}
            title={rxAutoWrap ? t("rxAutoWrapHintOn") : t("rxAutoWrapHintOff")}
          >
            <span className="serial-switch-led" aria-hidden="true" />
            <span className="serial-switch-text">{t("rxAutoWrap")}</span>
          </button>
        </aside>

        <main className="rx-panel">
          <div className="panel-head">
            <strong>{t("rxPanel")}</strong>
            <div>
              <button type="button" onClick={clearRx}>
                {t("clearRx")}
              </button>
              <button type="button" onClick={() => setPauseRx((v) => !v)}>
                {pauseRx ? t("resumeRx") : t("pauseRx")}
              </button>
              <select
                value={rxFormat}
                onChange={(e) => setRxFormat(e.target.value as "ASCII" | "HEX" | "BIN" | "DEC")}
              >
                <option value="ASCII">ASCII</option>
                <option value="HEX">HEX</option>
                <option value="BIN">BIN</option>
                <option value="DEC">DEC</option>
              </select>
              <select
                value={encodingMode}
                onChange={(e) => setEncodingMode(e.target.value as EncodingMode)}
                title="文本编码"
              >
                <option value="auto">{t("encodingAuto")}</option>
                <option value="utf-8">{t("encodingUtf8")}</option>
                <option value="gbk">{t("encodingGbk")}</option>
                <option value="ascii">{t("encodingAscii")}</option>
              </select>
            </div>
          </div>
          <textarea ref={rxTextareaRef} value={rxText} readOnly onScroll={handleRxScroll} onMouseDown={handleRxMouseDown} />
          {rxJumpBtnPos.visible && (
            <button
              type="button"
              className="rx-jump-latest-float"
              style={{ left: `${rxJumpBtnPos.x}px`, top: `${rxJumpBtnPos.y}px` }}
              onClick={scrollRxToLatest}
            >
              回到最新
            </button>
          )}
        </main>
        </section>
        <button
          type="button"
          className={homeQuickPanelOpen ? "home-quick-toggle open" : "home-quick-toggle"}
          style={{ right: homeQuickPanelOpen ? `${homeQuickPanelWidth}px` : "0px" }}
          onClick={() => setHomeQuickPanelOpen((v) => !v)}
          title={homeQuickPanelOpen ? "收起快捷发送" : "展开快捷发送"}
        >
          {homeQuickPanelOpen ? "▶" : "◀"}
        </button>
        <aside
          className={homeQuickPanelOpen ? "home-quick-panel open" : "home-quick-panel"}
          style={{ width: `${homeQuickPanelWidth}px`, right: homeQuickPanelOpen ? "0px" : `-${homeQuickPanelWidth}px` }}
        >
          <div className="home-quick-resize-handle" onMouseDown={startQuickPanelResize} />
          <h4>快捷发送</h4>
          <button type="button" onClick={addQuickSend} disabled={quickSends.length >= 100}>
            新增一条
          </button>
          <div className="home-quick-list">
            {quickSends.length === 0 ? (
              <p className="muted-text">暂无快捷发送</p>
            ) : (
              quickSends.slice(0, 12).map((item) => (
                <div key={item.id} className="home-quick-item">
                  <input
                    value={item.name}
                    onChange={(e) => updateQuickSend(item.id, { name: e.target.value })}
                    placeholder="名称"
                  />
                  <input
                    value={item.payload}
                    onChange={(e) => updateQuickSend(item.id, { payload: e.target.value })}
                    placeholder="发送内容"
                  />
                  <select
                    value={item.format}
                    onChange={(e) => updateQuickSend(item.id, { format: e.target.value as SendFormat })}
                  >
                    <option value="ASCII">A</option>
                    <option value="HEX">H</option>
                  </select>
                  <button type="button" onClick={() => void sendPayload({ payload: item.payload, format: item.format })}>
                    发送
                  </button>
                </div>
              ))
            )}
          </div>
          <h4>历史发送记录</h4>
          <div className="home-send-history-list">
            {txHistory.length === 0 ? (
              <p className="muted-text">暂无发送记录</p>
            ) : (
              <>
                {txHistory.slice(0, 30).map((x) => (
                  <div key={`${x.ts}-${x.text}`} className="home-send-history-item">
                    <span title={x.text}>[{formatTime(x.ts)}] {x.text}</span>
                    <button type="button" onClick={() => void sendPayload({ payload: x.text, format: sendFormat })}>
                      发送
                    </button>
                  </div>
                ))}
                {txHistory.length > 30 && (
                  <div className="home-send-history-vip">仅展示最近30条，升级VIP解锁更多发送记录</div>
                )}
              </>
            )}
          </div>
          <h4>数值图形分析</h4>
          <div className="home-chart-toolbar">
            <select value={chartSource} onChange={(e) => setChartSource(e.target.value as ChartSource)}>
              <option value="tx">TX</option>
              <option value="rx">RX</option>
              <option value="both">TX+RX</option>
            </select>
            <select value={chartKind} onChange={(e) => setChartKind(e.target.value as ChartKind)}>
              <option value="line">折线图</option>
              <option value="bar">柱状图</option>
            </select>
            <select value={String(chartWindow)} onChange={(e) => setChartWindow(e.target.value === "all" ? "all" : Number(e.target.value) as ChartWindow)}>
              <option value="30">最近30</option>
              <option value="100">最近100</option>
              <option value="500">最近500</option>
              <option value="all">全量</option>
            </select>
          </div>
          {chartStats ? (
            <div className="home-chart-stats">
              <span>数量 {chartStats.count}</span>
              <span>最小 {chartStats.min.toFixed(3)}</span>
              <span>最大 {chartStats.max.toFixed(3)}</span>
              <span>平均 {chartStats.avg.toFixed(3)}</span>
              <span>最新 {chartStats.latest.toFixed(3)}</span>
            </div>
          ) : (
            <div className="home-chart-stats empty">暂无可绘制数值</div>
          )}
          <div ref={chartContainerRef} className="home-chart-box" />
          <div className="home-chart-export">
            <input
              value={chartExportName}
              onChange={(e) => setChartExportName(e.target.value)}
              placeholder="文件名"
              title="导出文件名（不含后缀）"
            />
            <select value={chartPixelRatio} onChange={(e) => setChartPixelRatio(Math.max(1, Number(e.target.value) || 2))}>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
              <option value={4}>4x</option>
            </select>
            <select value={chartExportFormat} onChange={(e) => setChartExportFormat(e.target.value as ChartExportFormat)}>
              <option value="png">PNG</option>
              <option value="svg">SVG</option>
              <option value="pdf">PDF</option>
              <option value="bmp">BMP</option>
              <option value="jpg">JPG</option>
            </select>
            <button type="button" onClick={() => void exportQuickChart()}>
              另存图表
            </button>
          </div>
        </aside>
        </>
      ) : activeTab === "quick-settings" ? (
        <section className="settings-page">
          <div className="settings-card">
            <h3>{t("deviceSettings")}</h3>
            <p>在这里为 USB 串口设置别名，并指定默认端口。</p>
            <label>
              {t("port")}
              <select
                value={form.port}
                onChange={(e) => handlePortSelect(e.target.value)}
              >
                {ports.length === 0 ? (
                  <option value={form.port}>{form.port || "无可用端口"}</option>
                ) : (
                  ports.map((p) => (
                    <option key={p.id} value={p.path}>
                      {p.path} - {p.alias || p.friendlyName}
                      {p.preferred ? " (默认)" : ""}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              {t("alias")}
              <input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                placeholder="例如：工位A-主控串口"
              />
            </label>
            <div className="device-actions">
              <button type="button" onClick={() => void saveDeviceProfile(false)}>
                {t("saveAlias")}
              </button>
              <button type="button" onClick={() => void saveDeviceProfile(true)}>
                {t("setPreferred")}
              </button>
            </div>
            <label>
              {t("language")}
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
          </div>
          <div className="settings-card">
            <h3>快捷发送设置</h3>
            <p>可配置最多 100 条快捷发送项（名称 / 内容 / ASCII 或 HEX）。</p>
            <div className="device-actions">
              <button type="button" onClick={addQuickSend} disabled={quickSends.length >= 100}>
                新增一条
              </button>
              <span className="muted-text">
                已配置 {quickSends.length}/100
              </span>
            </div>
            <div className="quicksend-list">
              {quickSends.length === 0 ? (
                <p className="muted-text">暂无快捷发送配置</p>
              ) : (
                quickSends.map((item) => (
                  <div className="quicksend-item" key={item.id}>
                    <input
                      value={item.name}
                      onChange={(e) => updateQuickSend(item.id, { name: e.target.value })}
                      placeholder="名称"
                    />
                    <input
                      value={item.payload}
                      onChange={(e) => updateQuickSend(item.id, { payload: e.target.value })}
                      placeholder="发送内容"
                    />
                    <select
                      value={item.format}
                      onChange={(e) => updateQuickSend(item.id, { format: e.target.value as SendFormat })}
                    >
                      <option value="ASCII">ASCII</option>
                      <option value="HEX">HEX</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void sendPayload({ payload: item.payload, format: item.format })}
                    >
                      发送
                    </button>
                    <button type="button" onClick={() => removeQuickSend(item.id)}>
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="settings-page">
          <div className="settings-card">
            <h3>{t("theme")}</h3>
            <div className="theme-switch-row">
              <button
                type="button"
                className={theme === "light" ? "active" : ""}
                onClick={() => setTheme("light")}
              >
                {t("themeLight")}
              </button>
              <button
                type="button"
                className={theme === "dark" ? "active" : ""}
                onClick={() => setTheme("dark")}
              >
                {t("themeDark")}
              </button>
            </div>
            <div className="theme-demo">
              <div className="theme-demo-title">{t("themeDemo")}</div>
              <div className="theme-demo-toolbar">
                <button type="button">按钮</button>
                <select defaultValue="demo">
                  <option value="demo">下拉示例</option>
                </select>
              </div>
              <textarea readOnly value={"[12:00:01.001] RX demo\n[12:00:01.222] TX demo"} />
            </div>
          </div>
          <div className="settings-card">
            <h3>序列 / 触发发送</h3>
            <label>
              序列发送(每行: payload|ASCII/HEX|delayMs)
              <textarea value={seqText} onChange={(e) => setSeqText(e.target.value)} rows={4} />
            </label>
            <div className="device-actions">
              <button type="button" onClick={() => setSeqRunning(true)} disabled={seqRunning}>
                启动序列
              </button>
              <button type="button" onClick={() => setSeqRunning(false)} disabled={!seqRunning}>
                停止序列
              </button>
            </div>
            <label>
              触发关键字
              <input value={triggerKeyword} onChange={(e) => setTriggerKeyword(e.target.value)} />
            </label>
            <label>
              触发发送内容
              <input value={triggerPayload} onChange={(e) => setTriggerPayload(e.target.value)} />
            </label>
            <label>
              触发发送格式
              <select
                value={triggerFormat}
                onChange={(e) => setTriggerFormat((e.target.value as SendFormat) || "ASCII")}
              >
                <option value="ASCII">ASCII</option>
                <option value="HEX">HEX</option>
              </select>
            </label>
          </div>

          <div className="settings-card">
            <h3>文件发送</h3>
            <label>
              发送格式
              <select
                value={fileSendFormat}
                onChange={(e) => setFileSendFormat(e.target.value as FileSendFormat)}
              >
                <option value="binary">binary</option>
                <option value="ascii">ascii</option>
                <option value="hex">hex</option>
                <option value="xmodem128">xmodem128</option>
                <option value="xmodem1024">xmodem1024</option>
                <option value="ymodem128">ymodem128</option>
                <option value="ymodem1024">ymodem1024</option>
              </select>
            </label>
            <label>
              文件
              <input type="file" onChange={(e) => setFileToSend(e.target.files?.[0] ?? null)} />
            </label>
            <button type="button" onClick={() => void sendFile()} disabled={fileSending}>
              {fileSending ? "发送中..." : "发送文件"}
            </button>
          </div>

          <div className="settings-card">
            <h3>过滤 / 高亮</h3>
            <label>
              白名单(包含)
              <input value={whitelist} onChange={(e) => setWhitelist(e.target.value)} />
            </label>
            <label>
              黑名单(排除)
              <input value={blacklist} onChange={(e) => setBlacklist(e.target.value)} />
            </label>
            <label>
              正则过滤
              <input value={regexFilter} onChange={(e) => setRegexFilter(e.target.value)} />
            </label>
            <label>
              关键字高亮(逗号分隔)
              <input value={highlightKeys} onChange={(e) => setHighlightKeys(e.target.value)} />
            </label>
          </div>

          <div className="settings-card">
            <h3>CRC / Modbus / 日志</h3>
            <label>
              CRC输入(HEX)
              <input value={calcInput} onChange={(e) => setCalcInput(e.target.value)} />
            </label>
            <button type="button" onClick={runCrcCalc}>
              计算CRC
            </button>
            <p>{calcResult}</p>
            <label>
              Modbus帧(HEX)
              <input value={modbusInput} onChange={(e) => setModbusInput(e.target.value)} />
            </label>
            <button type="button" onClick={runModbusParse}>
              解析Modbus
            </button>
            <p>{modbusResult}</p>
            <div className="device-actions">
              <button type="button" onClick={() => exportLogs("txt")}>
                导出TXT
              </button>
              <button type="button" onClick={() => exportLogs("csv")}>
                导出CSV
              </button>
            </div>
            <div className="device-actions">
              <button type="button" onClick={() => exportLogs("json")}>
                导出JSON
              </button>
              <label>
                日志回放
                <input type="file" onChange={(e) => void onPlaybackFile(e.target.files?.[0] ?? null)} />
              </label>
            </div>
          </div>
        </section>
      )}

      <footer className="tx-panel">
        <div className="tx-input-wrap">
          <textarea
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onPaste={handleSendPaste}
            placeholder={t("txPlaceholder")}
          />
        </div>
        <div className="tx-actions">
          <div className="send-format-toggle">
            <button
              type="button"
              className={sendFormat === "ASCII" ? "active" : ""}
              onClick={() => handleSendFormatSwitch("ASCII")}
            >
              ASCII
            </button>
            <button
              type="button"
              className={sendFormat === "HEX" ? "active" : ""}
              onClick={() => handleSendFormatSwitch("HEX")}
            >
              HEX
            </button>
          </div>
          <button
            type="button"
            className={timerRunning ? "serial-switch is-on tx-send-toggle" : "serial-switch is-off tx-send-toggle"}
            onClick={handleSendToggle}
            aria-pressed={timerRunning}
          >
            <span className="serial-switch-led" aria-hidden="true" />
            <span className="serial-switch-text">{timerRunning ? "停止" : t("send")}</span>
          </button>
          <button
            type="button"
            className={timerCycleEnabled ? "serial-switch is-on tx-cycle-toggle" : "serial-switch is-off tx-cycle-toggle"}
            onClick={() => setTimerCycleEnabled((v) => !v)}
            aria-pressed={timerCycleEnabled}
            title={timerCycleEnabled ? "已开启循环发送" : "已关闭循环发送"}
          >
            <span className="serial-switch-led" aria-hidden="true" />
            <span className="serial-switch-text">循环发送</span>
          </button>
          <label>
            循环发送周期(ms)
            <input
              value={timerCycleMs}
              disabled={!timerCycleEnabled}
              onChange={(e) => setTimerCycleMs(Number(e.target.value) || 1000)}
            />
          </label>
          <select
            value={newlineMode}
            onChange={(e) => setNewlineMode(e.target.value as "None" | "CRLF" | "LF" | "CR")}
          >
            <option value="None">不追加换行</option>
            <option value="CRLF">追加 \\r\\n (0D 0A)</option>
            <option value="LF">追加 \\n (0A)</option>
            <option value="CR">追加 \\r (0D)</option>
          </select>
          <button type="button" onClick={clearTx}>
            {t("clearTx")}
          </button>
          <button type="button" onClick={clearStats}>
            {t("clearStats")}
          </button>
        </div>
      </footer>

      <div className="status-bar">
        <span>{statusText}</span>
        <span>{statusMsg}</span>
        <span>
          TX: {stats.txBytes} bytes / {stats.txFrames} frames
        </span>
        <span>
          RX: {stats.rxBytes} bytes / {stats.rxFrames} frames
        </span>
        <span>编码: {activeEncoding}</span>
      </div>
    </div>
  );
}

export default App;
