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

    static var savedToHistory: String {
        pick([
            "zh": "已保存到历史记录",
            "en": "Saved to History",
            "it": "Salvato in Cronologia",
            "es": "Guardado en Historial",
            "fr": "Enregistré dans l'historique",
            "de": "In Verlauf gespeichert",
            "pt": "Salvo no Histórico",
            "ja": "履歴に保存済み",
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

    static var recording: String {
        pick([
            "zh": "录音中",
            "en": "Recording",
            "it": "Registrazione",
            "es": "Grabando",
            "fr": "Enregistrement",
            "de": "Aufnahme",
            "pt": "Gravando",
            "ja": "録音中",
        ])
    }

    static var endRecording: String {
        pick([
            "zh": "结束录音",
            "en": "End recording",
            "it": "Termina registrazione",
            "es": "Terminar grabación",
            "fr": "Arrêter l'enregistrement",
            "de": "Aufnahme beenden",
            "pt": "Encerrar gravação",
            "ja": "録音を終了",
        ])
    }

    static var keepsSession: String {
        pick([
            "zh": "保留本次会话",
            "en": "Keeps this session",
            "it": "Conserva questa sessione",
            "es": "Conserva esta sesión",
            "fr": "Conserve cette session",
            "de": "Behält diese Sitzung",
            "pt": "Mantém esta sessão",
            "ja": "このセッションを保持",
        ])
    }

    static var ended: String {
        pick([
            "zh": "已结束",
            "en": "Ended",
            "it": "Terminato",
            "es": "Terminado",
            "fr": "Terminé",
            "de": "Beendet",
            "pt": "Encerrado",
            "ja": "終了",
        ])
    }

    static var continueRecording: String {
        pick([
            "zh": "继续录音",
            "en": "Continue recording",
            "it": "Continua a registrare",
            "es": "Seguir grabando",
            "fr": "Continuer l'enregistrement",
            "de": "Aufnahme fortsetzen",
            "pt": "Continuar gravação",
            "ja": "録音を続ける",
        ])
    }

    static var sameSession: String {
        pick([
            "zh": "同一会话",
            "en": "Same session",
            "it": "Stessa sessione",
            "es": "Misma sesión",
            "fr": "Même session",
            "de": "Dieselbe Sitzung",
            "pt": "Mesma sessão",
            "ja": "同じセッション",
        ])
    }

    static var saving: String {
        pick([
            "zh": "保存中…",
            "en": "Saving…",
            "it": "Salvataggio…",
            "es": "Guardando…",
            "fr": "Enregistrement…",
            "de": "Speichern…",
            "pt": "Salvando…",
            "ja": "保存中…",
        ])
    }

    static var waitingConfirmation: String {
        pick([
            "zh": "等待确认",
            "en": "Waiting for confirmation",
            "it": "In attesa di conferma",
            "es": "Esperando confirmación",
            "fr": "En attente de confirmation",
            "de": "Warte auf Bestätigung",
            "pt": "Aguardando confirmação",
            "ja": "確認待ち",
        ])
    }

    static var viewOnIphone: String {
        pick([
            "zh": "在 iPhone 上查看",
            "en": "View on iPhone",
            "it": "Vedi su iPhone",
            "es": "Ver en iPhone",
            "fr": "Voir sur iPhone",
            "de": "Auf iPhone ansehen",
            "pt": "Ver no iPhone",
            "ja": "iPhoneで見る",
        ])
    }

    static var couldntSave: String {
        pick([
            "zh": "未能保存",
            "en": "Couldn't save",
            "it": "Salvataggio non riuscito",
            "es": "No se pudo guardar",
            "fr": "Échec de l'enregistrement",
            "de": "Speichern fehlgeschlagen",
            "pt": "Não foi possível salvar",
            "ja": "保存できませんでした",
        ])
    }

    static var saveFailedHelp: String {
        pick([
            "zh": "请在 iPhone 上重试，或在此再试一次。",
            "en": "Try again on iPhone or retry here.",
            "it": "Riprova su iPhone o da qui.",
            "es": "Reintenta en iPhone o aquí.",
            "fr": "Réessayez sur iPhone ou ici.",
            "de": "Auf iPhone oder hier erneut versuchen.",
            "pt": "Tente de novo no iPhone ou aqui.",
            "ja": "iPhoneかここで再試行してください。",
        ])
    }

    static var retrySave: String {
        pick([
            "zh": "重试保存",
            "en": "Retry save",
            "it": "Riprova a salvare",
            "es": "Reintentar guardar",
            "fr": "Réessayer d'enregistrer",
            "de": "Speichern wiederholen",
            "pt": "Tentar salvar de novo",
            "ja": "保存を再試行",
        ])
    }

    static var ending: String {
        pick([
            "zh": "正在结束…",
            "en": "Ending…",
            "it": "Chiusura…",
            "es": "Finalizando…",
            "fr": "Fin…",
            "de": "Beenden…",
            "pt": "Encerrando…",
            "ja": "終了中…",
        ])
    }

    static var couldntEnd: String {
        pick([
            "zh": "未能结束 · 请重试",
            "en": "Couldn't end · try again",
            "it": "Chiusura non riuscita · riprova",
            "es": "No se pudo terminar · reintenta",
            "fr": "Impossible d'arrêter · réessayer",
            "de": "Beenden fehlgeschlagen · erneut",
            "pt": "Não foi possível encerrar · tente de novo",
            "ja": "終了できません · 再試行",
        ])
    }

    static var couldntDiscard: String {
        pick([
            "zh": "未能丢弃 · 请重试",
            "en": "Couldn't discard · try again",
            "it": "Eliminazione non riuscita · riprova",
            "es": "No se pudo descartar · reintenta",
            "fr": "Impossible d'ignorer · réessayer",
            "de": "Verwerfen fehlgeschlagen · erneut",
            "pt": "Não foi possível descartar · tente de novo",
            "ja": "破棄できません · 再試行",
        ])
    }
}
