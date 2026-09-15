import { watchUiLang, type UiLang } from './uiLang'

export type WatchUiLang = UiLang
export { watchUiLang }

export type WatchUiCopy = {
  listening: string
  dontSave: string
  save: string
  paused: string
  saved: string
  stopListening: string
  start: string
  stop: string
  ready: string
  pause: string
  resume: string
  hearQuestion: string
  drafting: string
  starting: string
  couldntStart: string
  replaying: string
  diskFull: string
  drainFailed: string
}

const COPY: Record<WatchUiLang, WatchUiCopy> = {
  zh: {
    listening: '听着',
    dontSave: '不保存',
    save: '保存',
    paused: '已暂停',
    saved: '已同步到手机',
    stopListening: '停止听写',
    start: '开始',
    stop: '停止',
    ready: '就绪',
    pause: '暂停',
    resume: '继续',
    hearQuestion: '听问题',
    drafting: '起草中',
    starting: '正在开始…',
    couldntStart: '无法开始 · 请在 iPhone 打开 Nodpilot',
    replaying: '正在补传',
    diskFull: '手表存储已满',
    drainFailed: '补传未完成',
  },
  en: {
    listening: "I'm listening.",
    dontSave: "Don't save",
    save: 'Save',
    paused: 'Paused',
    saved: 'Saved to iPhone',
    stopListening: 'Stop listening',
    start: 'Start',
    stop: 'Stop',
    ready: 'Ready',
    pause: 'Pause',
    resume: 'Resume',
    hearQuestion: 'Listening',
    drafting: 'Drafting',
    starting: 'Starting…',
    couldntStart: "Couldn't start · open Nodpilot on iPhone",
    replaying: 'Catching up',
    diskFull: 'Watch storage full',
    drainFailed: "Couldn't finish sending",
  },
  it: {
    listening: 'Ascolto',
    dontSave: 'Non salvare',
    save: 'Salva',
    paused: 'In pausa',
    saved: 'Salvato su iPhone',
    stopListening: 'Ferma',
    start: 'Avvia',
    stop: 'Stop',
    ready: 'Pronto',
    pause: 'Pausa',
    resume: 'Riprendi',
    hearQuestion: 'Ascolto',
    drafting: 'Sto scrivendo',
    starting: 'Avvio…',
    couldntStart: 'Impossibile avviare · apri Nodpilot su iPhone',
    replaying: 'Invio in corso',
    diskFull: 'Memoria piena',
    drainFailed: 'Invio non riuscito',
  },
  es: {
    listening: 'Escuchando',
    dontSave: 'No guardar',
    save: 'Guardar',
    paused: 'En pausa',
    saved: 'Guardado en iPhone',
    stopListening: 'Detener',
    start: 'Iniciar',
    stop: 'Stop',
    ready: 'Listo',
    pause: 'Pausa',
    resume: 'Seguir',
    hearQuestion: 'Escuchando',
    drafting: 'Redactando',
    starting: 'Iniciando…',
    couldntStart: 'No se pudo iniciar · abre Nodpilot en iPhone',
    replaying: 'Enviando audio',
    diskFull: 'Almacenamiento lleno',
    drainFailed: 'No se pudo enviar',
  },
  fr: {
    listening: "J'écoute",
    dontSave: 'Ne pas enregistrer',
    save: 'Enregistrer',
    paused: 'En pause',
    saved: 'Sauvé sur iPhone',
    stopListening: 'Arrêter',
    start: 'Démarrer',
    stop: 'Stop',
    ready: 'Prêt',
    pause: 'Pause',
    resume: 'Reprendre',
    hearQuestion: "J'écoute",
    drafting: 'Rédaction',
    starting: 'Démarrage…',
    couldntStart: 'Impossible de démarrer · ouvre Nodpilot sur iPhone',
    replaying: 'Envoi en cours',
    diskFull: 'Stockage plein',
    drainFailed: 'Envoi impossible',
  },
  de: {
    listening: 'Ich höre zu',
    dontSave: 'Nicht speichern',
    save: 'Speichern',
    paused: 'Pausiert',
    saved: 'Auf iPhone',
    stopListening: 'Stopp',
    start: 'Start',
    stop: 'Stopp',
    ready: 'Bereit',
    pause: 'Pause',
    resume: 'Weiter',
    hearQuestion: 'Ich höre zu',
    drafting: 'Schreibe…',
    starting: 'Startet…',
    couldntStart: 'Start fehlgeschlagen · Nodpilot auf dem iPhone öffnen',
    replaying: 'Wird nachgereicht',
    diskFull: 'Speicher voll',
    drainFailed: 'Senden fehlgeschlagen',
  },
  pt: {
    listening: 'Ouvindo',
    dontSave: 'Não salvar',
    save: 'Salvar',
    paused: 'Pausado',
    saved: 'Salvo no iPhone',
    stopListening: 'Parar',
    start: 'Iniciar',
    stop: 'Stop',
    ready: 'Pronto',
    pause: 'Pausar',
    resume: 'Seguir',
    hearQuestion: 'Ouvindo',
    drafting: 'Escrevendo',
    starting: 'Iniciando…',
    couldntStart: 'Não foi possível iniciar · abra o Nodpilot no iPhone',
    replaying: 'Enviando áudio',
    diskFull: 'Armazenamento cheio',
    drainFailed: 'Falha no envio',
  },
  ja: {
    listening: '聞いています',
    dontSave: '保存しない',
    save: '保存',
    paused: '一時停止',
    saved: 'iPhoneに保存',
    stopListening: '停止',
    start: '開始',
    stop: '停止',
    ready: '準備完了',
    pause: '一時停止',
    resume: '再開',
    hearQuestion: '質問を聞く',
    drafting: '作成中',
    starting: '開始中…',
    couldntStart: '開始できません · iPhoneでNodpilotを開く',
    replaying: '送信中',
    diskFull: '容量不足',
    drainFailed: '送信できませんでした',
  },
}

export function watchUiCopy(locale: string): WatchUiCopy {
  return COPY[watchUiLang(locale)]
}
