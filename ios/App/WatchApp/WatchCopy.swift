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
