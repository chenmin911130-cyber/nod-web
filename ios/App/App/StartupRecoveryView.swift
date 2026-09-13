import UIKit

/// The page the brand mask hands over to when the web layer's initialisation is
/// unrecoverably broken (issue #227): the native bundle never loaded, or it loaded and the
/// web app's JavaScript never ran and `#root` never filled. Without it the safety timeout
/// could only lift the mask onto a blank dark `WKWebView` with nothing actionable.
///
/// This is the one launch surface the design's "no text" rule explicitly exempts
/// (`docs/design/brand/launch-screen.md`: 异常恢复页面除外), so it carries exactly two
/// pieces of copy — one short line and one 重试 button — and nothing else: no slogan, no
/// version number, no percentage, no progress bar.
///
/// It is deliberately interactive. The mask itself sets `isUserInteractionEnabled = false`
/// so it never swallows a touch, but that also disables its whole subtree, so the mask
/// flips that back on while this page is up (`LaunchOverlay.showRecovery()`); otherwise
/// the button would be unreachable.
final class StartupRecoveryView: UIView {

    /// The page's only exit: the mask owns the reload, this view just reports the tap.
    var onRetry: (() -> Void)?

    private let messageLabel = UILabel()
    private let retryButton = UIButton(type: .system)

    // MARK: - Copy

    /// One line, in the device's own language, picked exactly the way the Watch app picks
    /// its strings (`WatchCopy`): this target has no copy table of its own — the web layer
    /// owns the product's i18n — so the two strings this page needs live with the page.
    private static var language: String {
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
        values[language] ?? values["en"] ?? ""
    }

    static var message: String {
        // Wording stays neutral about the cause: this page covers a broken bundle
        // and a failed first load, not only a bad network, so it must not tell the
        // user to check a connection that may be fine.
        pick([
            "zh": "无法加载，请重试",
            "en": "Couldn't load. Try again.",
            "it": "Impossibile caricare. Riprova.",
            "es": "No se pudo cargar. Inténtalo de nuevo.",
            "fr": "Échec du chargement. Réessayez.",
            "de": "Laden fehlgeschlagen. Erneut versuchen.",
            "pt": "Não foi possível carregar. Tente novamente.",
            "ja": "読み込めませんでした。もう一度お試しください。",
        ])
    }

    static var retryTitle: String {
        pick([
            "zh": "重试",
            "en": "Retry",
            "it": "Riprova",
            "es": "Reintentar",
            "fr": "Réessayer",
            "de": "Erneut versuchen",
            "pt": "Tentar novamente",
            "ja": "再試行",
        ])
    }

    // MARK: - Life cycle

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = BrandLaunch.backgroundColor
        isOpaque = true
        isUserInteractionEnabled = true
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        accessibilityIdentifier = "StartupRecovery"
        buildContent()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StartupRecoveryView is code-only")
    }

    private func buildContent() {
        messageLabel.text = Self.message
        messageLabel.textColor = BrandLaunch.inkColor
        messageLabel.font = .systemFont(ofSize: 15, weight: .regular)
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0
        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(messageLabel)

        retryButton.setTitle(Self.retryTitle, for: .normal)
        retryButton.setTitleColor(BrandLaunch.accentColor, for: .normal)
        retryButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        retryButton.layer.borderColor = BrandLaunch.accentColor.withAlphaComponent(0.55).cgColor
        retryButton.layer.borderWidth = 1
        retryButton.layer.cornerRadius = 22
        retryButton.accessibilityIdentifier = "StartupRecoveryRetry"
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        addSubview(retryButton)

        NSLayoutConstraint.activate([
            messageLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            messageLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -44),
            messageLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),
            messageLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -32),
            messageLabel.topAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.topAnchor, constant: 24),

            retryButton.centerXAnchor.constraint(equalTo: centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: messageLabel.bottomAnchor, constant: 28),
            retryButton.bottomAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.bottomAnchor, constant: -24),
            retryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 128),
            retryButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    @objc private func retryTapped() {
        onRetry?()
    }
}
