import Foundation

enum WatchCopy {
    private static var lang: String {
        let tag = (Locale.preferredLanguages.first ?? Locale.current.identifier)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        let code = tag.split(separator: "-").first.map(String.init) ?? "en"
        switch code {
        case "zh", "it", "es", "fr", "de", "pt", "ja":
            return code
        default:
            return "en"
        }
    }

    private static func pick(_ values: [String: String]) -> String {
        values[lang] ?? values["en"] ?? ""
    }

    static var listening: String {
        pick([
            "zh": "听着",
            "en": "I'm listening.",
            "it": "Ascolto",
            "es": "Escuchando",
            "fr": "J'écoute",
            "de": "Ich höre zu",
            "pt": "Ouvindo",
            "ja": "聞いています",
        ])
    }

    static var dontSave: String {
        pick([
            "zh": "不保存",
            "en": "Don't save",
            "it": "Non salvare",
            "es": "No guardar",
            "fr": "Ne pas enregistrer",
            "de": "Nicht speichern",
            "pt": "Não salvar",
            "ja": "保存しない",
        ])
    }

    static var save: String {
        pick([
            "zh": "保存",
            "en": "Save",
            "it": "Salva",
            "es": "Guardar",
            "fr": "Enregistrer",
            "de": "Speichern",
            "pt": "Salvar",
            "ja": "保存",
        ])
    }

    static var saving: String {
        pick([
            "zh": "正在保存…",
            "en": "Saving…",
            "it": "Salvataggio…",
            "es": "Guardando…",
            "fr": "Enregistrement…",
            "de": "Speichern…",
            "pt": "Salvando…",
            "ja": "保存中…",
        ])
    }

    static var saveFailed: String {
        pick([
            "zh": "无法保存",
            "en": "Couldn't save",
            "it": "Salvataggio non riuscito",
            "es": "No se pudo guardar",
            "fr": "Enregistrement impossible",
            "de": "Speichern fehlgeschlagen",
            "pt": "Não foi possível salvar",
            "ja": "保存できません",
        ])
    }

    static var retry: String {
        pick([
            "zh": "重试",
            "en": "Retry",
            "fr": "Réessayer",
            "es": "Reintentar",
            "it": "Riprova",
            "de": "Erneut versuchen",
            "pt": "Tentar novamente",
            "ja": "再試行",
        ])
    }

    static var done: String {
        pick([
            "zh": "完成",
            "en": "Done",
            "fr": "Terminé",
            "es": "Listo",
            "it": "Fatto",
            "de": "Fertig",
            "pt": "Concluído",
            "ja": "完了",
        ])
    }

    static var paused: String {
        pick([
            "zh": "已暂停",
            "en": "Paused",
            "it": "In pausa",
            "es": "En pausa",
            "fr": "En pause",
            "de": "Pausiert",
            "pt": "Pausado",
            "ja": "一時停止",
        ])
    }

    static var saved: String {
        pick([
            "zh": "已同步到手机",
            "en": "Saved to iPhone",
            "it": "Salvato su iPhone",
            "es": "Guardado en iPhone",
            "fr": "Sauvé sur iPhone",
            "de": "Auf iPhone",
            "pt": "Salvo no iPhone",
            "ja": "iPhoneに保存",
        ])
    }

    static var stopListening: String {
        pick([
            "zh": "停止听写",
            "en": "Stop listening",
            "it": "Ferma",
            "es": "Detener",
            "fr": "Arrêter",
            "de": "Stopp",
            "pt": "Parar",
            "ja": "停止",
        ])
    }

    static var start: String {
        pick([
            "zh": "开始",
            "en": "Start",
            "it": "Avvia",
            "es": "Iniciar",
            "fr": "Démarrer",
            "de": "Start",
            "pt": "Iniciar",
            "ja": "開始",
        ])
    }

    static var starting: String {
        pick([
            "zh": "正在开始…",
            "en": "Starting…",
            "it": "Avvio…",
            "es": "Iniciando…",
            "fr": "Démarrage…",
            "de": "Startet…",
            "pt": "Iniciando…",
            "ja": "開始中…",
        ])
    }

    static var couldntStart: String {
        pick([
            "zh": "无法开始 · 请在 iPhone 打开 Nodpilot",
            "en": "Couldn't start · open Nodpilot on iPhone",
            "it": "Impossibile avviare · apri Nodpilot su iPhone",
            "es": "No se pudo iniciar · abre Nodpilot en iPhone",
            "fr": "Impossible de démarrer · ouvre Nodpilot sur iPhone",
            "de": "Start fehlgeschlagen · Nodpilot auf dem iPhone öffnen",
            "pt": "Não foi possível iniciar · abra o Nodpilot no iPhone",
            "ja": "開始できません · iPhoneでNodpilotを開く",
        ])
    }

    static var stop: String {
        pick([
            "zh": "停止",
            "en": "Stop",
            "it": "Stop",
            "es": "Stop",
            "fr": "Stop",
            "de": "Stopp",
            "pt": "Stop",
            "ja": "停止",
        ])
    }

    static var ready: String {
        pick([
            "zh": "就绪",
            "en": "Ready",
            "it": "Pronto",
            "es": "Listo",
            "fr": "Prêt",
            "de": "Bereit",
            "pt": "Pronto",
            "ja": "準備完了",
        ])
    }

    static var pause: String {
        pick([
            "zh": "暂停",
            "en": "Pause",
            "it": "Pausa",
            "es": "Pausa",
            "fr": "Pause",
            "de": "Pause",
            "pt": "Pausar",
            "ja": "一時停止",
        ])
    }

    static var resume: String {
        pick([
            "zh": "继续",
            "en": "Resume",
            "it": "Riprendi",
            "es": "Seguir",
            "fr": "Reprendre",
            "de": "Weiter",
            "pt": "Seguir",
            "ja": "再開",
        ])
    }

    static var hearQuestion: String {
        pick([
            "zh": "听问题",
            "en": "Listening",
            "it": "Ascolto",
            "es": "Escuchando",
            "fr": "J'écoute",
            "de": "Ich höre zu",
            "pt": "Ouvindo",
            "ja": "質問を聞く",
        ])
    }

    static var drafting: String {
        pick([
            "zh": "起草中",
            "en": "Drafting",
            "it": "Sto scrivendo",
            "es": "Redactando",
            "fr": "Rédaction",
            "de": "Schreibe…",
            "pt": "Escrevendo",
            "ja": "作成中",
        ])
    }

    static var replaying: String {
        pick([
            "zh": "正在补传",
            "en": "Catching up",
            "it": "Invio in corso",
            "es": "Enviando audio",
            "fr": "Envoi en cours",
            "de": "Wird nachgereicht",
            "pt": "Enviando áudio",
            "ja": "送信中",
        ])
    }

    static var pcmIncomplete: String {
        pick([
            "zh": "音频不完整 — 可能有缺失",
            "en": "Audio incomplete — may be missing",
            "it": "Audio incompleto",
            "es": "Audio incompleto",
            "fr": "Audio incomplet",
            "de": "Audio unvollständig",
            "pt": "Áudio incompleto",
            "ja": "音声が不完全です",
        ])
    }

    /// Session ended server-side; the trailing upload cannot complete (issue #165 P2-8).
    static var pcmRejected: String {
        pick([
            "zh": "会话已结束，补传未完成。",
            "en": "Session ended — upload incomplete.",
            "it": "Sessione terminata, caricamento incompleto.",
            "es": "Sesión finalizada — carga incompleta.",
            "fr": "Session terminée — envoi incomplet.",
            "de": "Sitzung beendet — Upload unvollständig.",
            "pt": "Sessão encerrada — envio incompleto.",
            "ja": "セッションが終了し、アップロードが未完了です。",
        ])
    }

    /// Storage-management entry (issue #165 review P2-7).
    static var transferBusy: String { pick(["zh": "文件仍在传输，请稍后再删除", "en": "File is transferring. Try deleting later."]) }
    static var deleteFailed: String { pick(["zh": "未能删除，录音已保留", "en": "Could not delete. Recording kept."]) }

    static var manageStorage: String {
        pick([
            "zh": "管理存储",
            "en": "Manage storage",
            "it": "Gestisci spazio",
            "es": "Gestionar almacenamiento",
            "fr": "Gérer le stockage",
            "de": "Speicher verwalten",
            "pt": "Gerir armazenamento",
            "ja": "ストレージを管理",
        ])
    }

    static var unfinishedRecordings: String {
        pick([
            "zh": "未完成录音",
            "en": "Unfinished recordings",
            "it": "Registrazioni incomplete",
            "es": "Grabaciones incompletas",
            "fr": "Enregistrements incomplets",
            "de": "Unvollständige Aufnahmen",
            "pt": "Gravações incompletas",
            "ja": "未完了の録音",
        ])
    }

    static var noUnfinished: String {
        pick([
            "zh": "没有未完成录音",
            "en": "No unfinished recordings",
            "it": "Nessuna registrazione incompleta",
            "es": "No hay grabaciones incompletas",
            "fr": "Aucun enregistrement incomplet",
            "de": "Keine unvollständigen Aufnahmen",
            "pt": "Sem gravações incompletas",
            "ja": "未完了の録音はありません",
        ])
    }

    static var confirmDelete: String {
        pick([
            "zh": "删除？",
            "en": "Delete?",
            "it": "Eliminare?",
            "es": "¿Eliminar?",
            "fr": "Supprimer ?",
            "de": "Löschen?",
            "pt": "Excluir?",
            "ja": "削除しますか？",
        ])
    }

    static var diskFull: String {
        pick([
            "zh": "手表存储已满",
            "en": "Watch storage full",
            "it": "Memoria piena",
            "es": "Almacenamiento lleno",
            "fr": "Stockage plein",
            "de": "Speicher voll",
            "pt": "Armazenamento cheio",
            "ja": "容量不足",
        ])
    }

    static var drainFailed: String {
        pick([
            "zh": "补传未完成",
            "en": "Couldn't finish sending",
            "it": "Invio non riuscito",
            "es": "No se pudo enviar",
            "fr": "Envoi impossible",
            "de": "Senden fehlgeschlagen",
            "pt": "Falha no envio",
            "ja": "送信できませんでした",
        ])
    }

    static var saveAsk: String {
        pick([
            "zh": "存进 History？",
            "en": "Save to History?",
            "it": "Salvare?",
            "es": "¿Guardar?",
            "fr": "Enregistrer ?",
            "de": "Speichern?",
            "pt": "Salvar?",
            "ja": "保存しますか？",
        ])
    }
}
