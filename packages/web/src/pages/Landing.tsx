import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Container,
  Database,
  KeyRound,
  Menu,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
import "./landing.css";

const NAV_LINKS = [
  { href: "#tinh-nang", label: "Tính năng" },
  { href: "#quy-trinh", label: "Quy trình" },
  { href: "#faq", label: "Câu hỏi" },
  { href: "#lien-he", label: "Liên hệ" },
];

const CONTACT_EMAIL = "contact@sondoan.dev";

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <div className="landing-page" id="top">
      <a className="landing-skip" href="#noi-dung-chinh">
        Bỏ qua tới nội dung chính
      </a>

      {/* ── Nav ─────────────────────────────────────────── */}
      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a className="landing-brand" href="#top" onClick={closeMenu} aria-label="FlexServer — về đầu trang">
            <span className="landing-brand-mark" aria-hidden="true">
              <Server size={18} strokeWidth={2.25} />
            </span>
            <span className="landing-brand-text">
              <span className="landing-brand-name">FlexServer</span>
              <span className="landing-brand-sub">by Sondoan Technology</span>
            </span>
          </a>

          <nav className="landing-nav" aria-label="Điều hướng chính">
            <ul className="landing-nav-links">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a className="landing-nav-link" href={link.href}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="landing-header-actions">
            <a className="landing-nav-link landing-nav-login" href="#lien-he">
              Liên hệ
            </a>
            <Link className="landing-btn landing-btn-primary landing-btn-small" to="/vps">
              Mở dashboard
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <button
              type="button"
              className="landing-menu-button"
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              aria-label={menuOpen ? "Đóng menu điều hướng" : "Mở menu điều hướng"}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {menuOpen ? (
          <div className="landing-mobile-panel" id="landing-mobile-menu">
            <nav aria-label="Điều hướng di động">
              <ul className="landing-mobile-links">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a className="landing-mobile-link" href={link.href} onClick={closeMenu}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="landing-mobile-cta">
              <Link className="landing-btn landing-btn-primary landing-btn-block" to="/vps" onClick={closeMenu}>
                Mở dashboard
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <a className="landing-btn landing-btn-secondary landing-btn-block" href="#lien-he" onClick={closeMenu}>
                Liên hệ tư vấn
              </a>
            </div>
          </div>
        ) : null}
      </header>

      <main id="noi-dung-chinh">
        {/* ── Hero ──────────────────────────────────────── */}
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <div className="landing-wrap landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">
                <span className="landing-eyebrow-dot" aria-hidden="true" />
                Self-hosted · Demo sẵn sàng · Không cần VPS thật để thử
              </p>
              <h1 className="landing-hero-title" id="landing-hero-title">
                Tất cả VPS của bạn.
                <br />
                <span className="landing-hero-accent">Một bảng điều khiển duy nhất.</span>
              </h1>
              <p className="landing-hero-sub">
                FlexServer gom mọi máy chủ vào một workspace gọn: theo dõi CPU, RAM, disk,
                network, Docker, jobs SSH và audit log — từ bản demo mô phỏng tới triển khai
                local an toàn cho hạ tầng thật.
              </p>
              <div className="landing-hero-ctas">
                <Link className="landing-btn landing-btn-primary" to="/vps">
                  Mở bảng điều khiển
                  <ArrowRight size={17} aria-hidden="true" />
                </Link>
                <a className="landing-btn landing-btn-secondary" href="#tinh-nang">
                  Khám phá tính năng
                </a>
              </div>
              <ul className="landing-hero-meta" aria-label="Điểm nổi bật">
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Demo không cần SSH thật
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Dữ liệu nằm trên máy của bạn
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  JSON hoặc PostgreSQL
                </li>
              </ul>
            </div>

            {/* ── Illustrative product console (static sample) ── */}
            <figure className="landing-console" aria-labelledby="landing-console-title">
              <div className="landing-console-chrome">
                <span className="landing-chrome-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="landing-chrome-title" id="landing-console-title">
                  workspace / vps-prod-01 — Tổng quan
                </span>
                <span className="landing-sample-badge">Dữ liệu minh họa</span>
              </div>
              <p className="landing-console-notice">
                Ảnh minh họa tĩnh — mọi con số bên dưới là giá trị mẫu, không phải dữ liệu trực tiếp.
              </p>
              <div className="landing-console-body">
                <div className="landing-hosts" aria-label="Danh sách máy chủ mẫu">
                  <div className="landing-host-row is-online">
                    <span className="landing-host-dot" aria-hidden="true" />
                    <span className="landing-host-name">vps-prod-01</span>
                    <span className="landing-host-meta tnum">CPU 38% · RAM 62%</span>
                  </div>
                  <div className="landing-host-row is-online">
                    <span className="landing-host-dot" aria-hidden="true" />
                    <span className="landing-host-name">vps-staging-02</span>
                    <span className="landing-host-meta tnum">CPU 12% · RAM 34%</span>
                  </div>
                  <div className="landing-host-row is-stale">
                    <span className="landing-host-dot" aria-hidden="true" />
                    <span className="landing-host-name">vps-backup-03</span>
                    <span className="landing-host-meta tnum">Snapshot cũ · n/a</span>
                  </div>
                </div>

                <div className="landing-metrics">
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">CPU</span>
                      <span className="landing-metric-value tnum">38%</span>
                    </div>
                    <div className="landing-meter" role="img" aria-label="CPU mẫu 38 phần trăm">
                      <span className="landing-meter-fill is-cpu" style={{ width: "38%" }} />
                    </div>
                    <span className="landing-metric-cap tnum">4 vCPU · load 1.24</span>
                  </div>
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">Memory</span>
                      <span className="landing-metric-value tnum">62%</span>
                    </div>
                    <div className="landing-meter" role="img" aria-label="RAM mẫu 62 phần trăm">
                      <span className="landing-meter-fill is-mem" style={{ width: "62%" }} />
                    </div>
                    <span className="landing-metric-cap tnum">7.4 / 12 GiB</span>
                  </div>
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">Disk</span>
                      <span className="landing-metric-value tnum">41%</span>
                    </div>
                    <div className="landing-meter" role="img" aria-label="Disk mẫu 41 phần trăm">
                      <span className="landing-meter-fill is-disk" style={{ width: "41%" }} />
                    </div>
                    <span className="landing-metric-cap tnum">82 / 200 GiB</span>
                  </div>
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">Network</span>
                      <span className="landing-metric-value tnum">1.24 MiB/s</span>
                    </div>
                    <div className="landing-meter" role="img" aria-label="Network mẫu RX 1.24 MiB trên giây">
                      <span className="landing-meter-fill is-net" style={{ width: "54%" }} />
                    </div>
                    <span className="landing-metric-cap tnum">RX 1.24 MiB/s · TX 380 KiB/s</span>
                  </div>
                </div>

                <div className="landing-panels">
                  <div className="landing-panel">
                    <p className="landing-panel-title">
                      <Activity size={14} aria-hidden="true" />
                      Lịch sử mẫu · 60 phút
                    </p>
                    <svg
                      className="landing-chart"
                      viewBox="0 0 260 72"
                      role="img"
                      aria-label="Biểu đồ minh họa tĩnh: CPU và memory dao động trong 60 phút mẫu"
                    >
                      <g aria-hidden="true">
                        <line x1="0" y1="18" x2="260" y2="18" className="landing-chart-grid" />
                        <line x1="0" y1="36" x2="260" y2="36" className="landing-chart-grid" />
                        <line x1="0" y1="54" x2="260" y2="54" className="landing-chart-grid" />
                        <polyline
                          points="0,44 22,40 44,42 66,34 88,36 110,28 132,31 154,24 176,27 198,20 220,24 242,18 260,21"
                          className="landing-chart-line is-cpu"
                        />
                        <polyline
                          points="0,52 22,50 44,51 66,48 88,49 110,46 132,47 154,44 176,45 198,42 220,44 242,41 260,43"
                          className="landing-chart-line is-mem"
                        />
                      </g>
                    </svg>
                    <p className="landing-panel-meta">
                      <span className="landing-legend is-cpu">CPU</span>
                      <span className="landing-legend is-mem">Memory</span>
                      <span className="tnum">uptime 42 ngày</span>
                    </p>
                  </div>
                  <div className="landing-panel">
                    <p className="landing-panel-title">
                      <TerminalSquare size={14} aria-hidden="true" />
                      Jobs mẫu gần đây
                    </p>
                    <ul className="landing-jobs">
                      <li className="landing-job-row">
                        <span className="landing-job-name">backup-nightly</span>
                        <span className="landing-pill is-ok">Thành công</span>
                      </li>
                      <li className="landing-job-row">
                        <span className="landing-job-name">deploy-api · <span className="tnum">62%</span></span>
                        <span className="landing-pill is-run">Đang chạy</span>
                      </li>
                      <li className="landing-job-row">
                        <span className="landing-job-name">rotate-logs</span>
                        <span className="landing-pill is-idle">Chờ lịch</span>
                      </li>
                    </ul>
                    <p className="landing-panel-meta">6 containers · audit 128 sự kiện mẫu</p>
                  </div>
                </div>
              </div>
              <figcaption className="landing-console-caption">
                Minh họa bố cục workspace — số liệu tĩnh để mô tả giao diện, không phản ánh máy chủ của bạn.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* ── Features bento ──────────────────────────────── */}
        <section className="landing-section" id="tinh-nang" aria-labelledby="landing-features-title">
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Tính năng</p>
              <h2 className="landing-section-title" id="landing-features-title">
                Mọi thứ bạn cần để vận hành VPS mỗi ngày
              </h2>
              <p className="landing-section-sub">
                Một workspace gọn cho giám sát, Docker, lệnh từ xa và truy vết — giữ nguyên quy tắc
                hiển thị trung thực: thiếu dữ liệu thì ghi rõ, không đoán mò.
              </p>
            </div>

            <div className="landing-bento">
              <article className="landing-card landing-card-large">
                <span className="landing-card-icon" aria-hidden="true">
                  <Activity size={20} />
                </span>
                <h3 className="landing-card-title">Giám sát tài nguyên theo từng host</h3>
                <p className="landing-card-desc">
                  CPU, RAM, disk, load, network RX/TX theo đơn vị bytes/s và uptime — mỗi VPS có
                  cửa sổ lịch sử riêng tới 120 mẫu, khoảng trống hiển thị đúng thay vì nối đường giả.
                </p>
                <ul className="landing-card-list">
                  <li><Check size={14} aria-hidden="true" /> Đơn vị nhị phân nhất quán GiB / MiB / KiB</li>
                  <li><Check size={14} aria-hidden="true" /> Thiếu lịch sử ghi rõ, không dán nhãn sai</li>
                  <li><Check size={14} aria-hidden="true" /> Số tabular gọn cho telemetry</li>
                </ul>
              </article>

              <article className="landing-card">
                <span className="landing-card-icon" aria-hidden="true">
                  <Container size={20} />
                </span>
                <h3 className="landing-card-title">Docker trong tab riêng</h3>
                <p className="landing-card-desc">
                  Theo dõi container độc lập với sức khỏe host, kèm nhãn snapshot khi số liệu đã cũ.
                </p>
              </article>

              <article className="landing-card">
                <span className="landing-card-icon" aria-hidden="true">
                  <TerminalSquare size={20} />
                </span>
                <h3 className="landing-card-title">Jobs &amp; lệnh có tiến độ thật</h3>
                <p className="landing-card-desc">
                  Thanh tiến độ chỉ hiện khi job đang chạy; job lỗi nêu rõ phần trăm, lý do và thời điểm.
                </p>
              </article>

              <article className="landing-card">
                <span className="landing-card-icon" aria-hidden="true">
                  <KeyRound size={20} />
                </span>
                <h3 className="landing-card-title">SSH &amp; khóa có kiểm soát</h3>
                <p className="landing-card-desc">
                  Cấp phát và xác minh key theo policy host, tin cậy host key tường minh, chặn dải mạng
                  private theo mặc định.
                </p>
              </article>

              <article className="landing-card">
                <span className="landing-card-icon" aria-hidden="true">
                  <Search size={20} />
                </span>
                <h3 className="landing-card-title">Audit log truy vết được</h3>
                <p className="landing-card-desc">
                  Mỗi sự kiện giữ thời gian, tác nhân, hành động và kết quả — hàng lỗi liên kết thẳng tới Jobs.
                </p>
              </article>

              <article className="landing-card">
                <span className="landing-card-icon" aria-hidden="true">
                  <Database size={20} />
                </span>
                <h3 className="landing-card-title">Agent &amp; lưu trữ linh hoạt</h3>
                <p className="landing-card-desc">
                  Agent Go nhẹ hoặc collector tích hợp, stream SSE trực tiếp, lưu JSON cho máy nhỏ hoặc
                  PostgreSQL cho đội nhóm.
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* ── Workflow ────────────────────────────────────── */}
        <section className="landing-section landing-section-alt" id="quy-trinh" aria-labelledby="landing-workflow-title">
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Quy trình</p>
              <h2 className="landing-section-title" id="landing-workflow-title">
                Từ máy chủ mới tới vận hành ổn định trong ba bước
              </h2>
              <p className="landing-section-sub">
                Bắt đầu bằng bản demo mô phỏng, chuyển sang hạ tầng thật khi bạn sẵn sàng — không phải
                nhập lại dữ liệu.
              </p>
            </div>

            <ol className="landing-workflow">
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">01</span>
                <h3 className="landing-step-title">Thêm VPS &amp; xác thực SSH</h3>
                <p className="landing-step-desc">
                  Nhập host, user và cổng, sau đó cấp phát hoặc xác minh SSH key. Môi trường local chặn
                  target ngoài policy cho tới khi bạn cho phép tường minh.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">02</span>
                <h3 className="landing-step-title">Kết nối thu thập metrics</h3>
                <p className="landing-step-desc">
                  Cài agent Go qua systemd hoặc dùng collector tích hợp. Biểu đồ CPU, memory và network
                  RX/TX bắt đầu đổ đầy sau vài mẫu thu thập.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">03</span>
                <h3 className="landing-step-title">Vận hành hằng ngày</h3>
                <p className="landing-step-desc">
                  Chạy jobs, kiểm tra Docker, đọc audit và mở terminal web khi thật sự cần (tắt mặc định,
                  chỉ bật ở chế độ local với cấu hình phù hợp).
                </p>
              </li>
            </ol>

            <div className="landing-modes">
              <div className="landing-mode">
                <p className="landing-mode-title">
                  <Zap size={15} aria-hidden="true" />
                  Chế độ demo
                </p>
                <p className="landing-mode-desc">
                  Dữ liệu mô phỏng, không SSH thật, không cần đăng nhập — phù hợp khám phá và chụp ảnh giao diện.
                </p>
              </div>
              <div className="landing-mode">
                <p className="landing-mode-title">
                  <ShieldCheck size={15} aria-hidden="true" />
                  Chế độ local
                </p>
                <p className="landing-mode-desc">
                  Dữ liệu thật, đăng nhập bằng mật khẩu dashboard, SSH chịu policy an toàn và lưu trữ do bạn chọn.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── FAQ ─────────────────────────────────────────── */}
        <section className="landing-section" id="faq" aria-labelledby="landing-faq-title">
          <div className="landing-wrap landing-faq-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Câu hỏi thường gặp</p>
              <h2 className="landing-section-title" id="landing-faq-title">
                Hỏi nhanh, đáp gọn
              </h2>
            </div>

            <div className="landing-faq">
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Chưa có VPS thật thì dùng thử được không?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Được. Chế độ demo (<span className="tnum">APP_MODE=demo</span>) dùng dữ liệu mô phỏng cho
                  máy chủ, metrics, jobs và terminal nên bạn khám phá toàn bộ workspace mà không cần SSH hay
                  thông tin đăng nhập nào.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Dữ liệu của tôi được lưu ở đâu?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Ngay trên hạ tầng của bạn: JSON cho triển khai nhỏ, PostgreSQL (tùy chọn TimescaleDB) cho
                  đội nhóm qua Docker Compose. Không có dịch vụ trung gian nào giữ dữ liệu của bạn.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Kết nối SSH có an toàn không?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  SSH ở chế độ local tuân thủ policy host: chỉ target được cho phép, host key phải được tin
                  cậy tường minh và dải mạng private bị chặn mặc định. Khóa và secret không bao giờ xuất hiện
                  trong issues hay commits.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Giám sát Docker hoạt động thế nào?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Docker nằm ở tab workspace riêng, tách khỏi sức khỏe host. Quyền truy cập socket Docker không
                  được cấp mặc định vì tương đương quyền root; số liệu cũ luôn kèm nhãn snapshot rõ ràng.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>“History unavailable” nghĩa là gì?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Nghĩa là cửa sổ lịch sử của host đó chưa có đủ mẫu dùng được — mẫu đầu, counter reset hoặc
                  network chưa đo được sẽ thành khoảng trống, không nội suy hay điền số 0. Biểu đồ đầy dần khi
                  mẫu mới tới.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Có cần mở dashboard ra internet không?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Không. Bạn có thể triển khai dashboard trong mạng nội bộ. Khi truy cập qua mạng, hãy cấu hình
                  HTTPS, origin và cookie phù hợp. Terminal web mặc định tắt và chỉ nên bật khi bạn đã đọc kỹ
                  mô hình bảo mật.
                </p>
              </details>
            </div>
          </div>
        </section>

        {/* ── Contact CTA ─────────────────────────────────── */}
        <section className="landing-section" id="lien-he" aria-labelledby="landing-contact-title">
          <div className="landing-wrap">
            <div className="landing-contact-panel">
              <p className="landing-section-eyebrow">Liên hệ</p>
              <h2 className="landing-contact-title" id="landing-contact-title">
                Triển khai FlexServer cho hạ tầng của bạn
              </h2>
              <p className="landing-contact-sub">
                Kể cho chúng tôi về số lượng VPS, nhu cầu giám sát và cách bạn muốn lưu trữ —
                đội ngũ Sondoan Technology sẽ gợi ý cấu hình demo, local hay Docker Compose phù hợp.
              </p>
              <div className="landing-contact-actions">
                <a className="landing-btn landing-btn-primary" href={`mailto:${CONTACT_EMAIL}?subject=Tri%E1%BB%83n%20khai%20FlexServer%20cho%20h%E1%BA%A1%20t%E1%BA%A7ng%20c%E1%BB%A7a%20t%C3%B4i`}>
                  Gửi email liên hệ
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
                <Link className="landing-btn landing-btn-secondary" to="/vps">
                  Khám phá bảng điều khiển
                </Link>
              </div>
              <p className="landing-contact-email">
                Hoặc viết trực tiếp tới <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ────────────────────────────────────────── */}
      <footer className="landing-footer">
        <div className="landing-wrap landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="landing-brand" aria-hidden="true">
              <span className="landing-brand-mark">
                <Server size={18} strokeWidth={2.25} />
              </span>
              <span className="landing-brand-text">
                <span className="landing-brand-name">FlexServer</span>
                <span className="landing-brand-sub">by Sondoan Technology</span>
              </span>
            </span>
            <p className="landing-footer-tagline">
              Bảng điều khiển self-hosted để quản lý VPS tập trung — giám sát, Docker, jobs và audit
              trong một workspace.
            </p>
          </div>
          <nav className="landing-footer-col" aria-label="Sản phẩm">
            <p className="landing-footer-heading">Sản phẩm</p>
            <Link className="landing-footer-link" to="/vps">Bảng điều khiển</Link>
            <a className="landing-footer-link" href="#tinh-nang">Tính năng</a>
            <a className="landing-footer-link" href="#quy-trinh">Quy trình</a>
          </nav>
          <nav className="landing-footer-col" aria-label="Hỗ trợ">
            <p className="landing-footer-heading">Hỗ trợ</p>
            <a className="landing-footer-link" href="#faq">Câu hỏi thường gặp</a>
            <a
              className="landing-footer-link"
              href="https://github.com/sondoan17/vps-manager-nodejs/issues"
              target="_blank"
              rel="noreferrer"
            >
              Báo lỗi / góp ý
            </a>
            <a className="landing-footer-link" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </nav>
        </div>
        <div className="landing-wrap landing-footer-bottom">
          <p>© 2026 Sondoan Technology. FlexServer — quản lý VPS tập trung.</p>
          <p className="landing-footer-note">Số liệu minh họa trên trang này là tĩnh, không phải dữ liệu trực tiếp.</p>
        </div>
      </footer>
    </div>
  );
}
