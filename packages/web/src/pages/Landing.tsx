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
  History,
  Menu,
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
  { href: "#che-do", label: "Chế độ sử dụng" },
  { href: "#faq", label: "Câu hỏi" },
];

const CONTACT_EMAIL = "contact@sondoan.dev";
const README_URL = "https://github.com/sondoan17/vps-manager-nodejs#readme";
const DEPLOY_URL =
  "https://github.com/sondoan17/vps-manager-nodejs#deploy-with-docker-compose";
const SECURITY_URL =
  "https://github.com/sondoan17/vps-manager-nodejs/blob/main/docs/security.md";

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

  return (
    <div className="landing-page" id="top">
      <a className="landing-skip" href="#noi-dung-chinh">
        Bỏ qua tới nội dung chính
      </a>

      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a
            className="landing-brand"
            href="#top"
            onClick={() => setMenuOpen(false)}
            aria-label="FlexServer — về đầu trang"
          >
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
            <Link
              className="landing-btn landing-btn-primary landing-btn-small"
              to="/vps"
            >
              Mở bảng điều khiển
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <button
              type="button"
              className="landing-menu-button"
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              aria-label={
                menuOpen ? "Đóng menu điều hướng" : "Mở menu điều hướng"
              }
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? (
                <X size={20} aria-hidden="true" />
              ) : (
                <Menu size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {menuOpen ? (
          <div className="landing-mobile-panel" id="landing-mobile-menu">
            <nav aria-label="Điều hướng di động">
              <ul className="landing-mobile-links">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      className="landing-mobile-link"
                      href={link.href}
                      onClick={() => setMenuOpen(false)}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="landing-mobile-cta">
              <Link
                className="landing-btn landing-btn-primary landing-btn-block"
                to="/vps"
                onClick={() => setMenuOpen(false)}
              >
                Mở bảng điều khiển
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        ) : null}
      </header>

      <main id="noi-dung-chinh" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <div className="landing-wrap landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">
                <span className="landing-eyebrow-dot" aria-hidden="true" />
                Bảng điều khiển VPS self-hosted
              </p>
              <h1 className="landing-hero-title" id="landing-hero-title">
                <span className="landing-hero-line">Quản lý mọi VPS.</span>
                <span className="landing-hero-line landing-hero-accent">
                  Từ một dashboard.
                </span>
              </h1>
              <p className="landing-hero-sub">
                Theo dõi tài nguyên, kiểm tra Docker và quản lý tác vụ SSH trên
                nhiều máy chủ — trong một giao diện tập trung, tự triển khai
                trên hạ tầng của bạn.
              </p>
              <div className="landing-hero-ctas">
                <Link className="landing-btn landing-btn-primary" to="/vps">
                  Mở bảng điều khiển
                  <ArrowRight size={17} aria-hidden="true" />
                </Link>
                <a
                  className="landing-btn landing-btn-secondary"
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Xem cách triển khai
                </a>
              </div>
              <p className="landing-hero-caveat">
                Bảng điều khiển yêu cầu mật khẩu khi chạy ở chế độ local.
              </p>
              <ul className="landing-hero-meta" aria-label="Điểm nổi bật">
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Nhiều VPS trong một nơi
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Theo dõi tài nguyên từng máy
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Tự triển khai trên hạ tầng của bạn
                </li>
              </ul>
            </div>

            <figure
              className="landing-console"
              aria-labelledby="landing-console-title"
            >
              <div className="landing-console-chrome">
                <span className="landing-chrome-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span
                  className="landing-chrome-title"
                  id="landing-console-title"
                >
                  vps-prod-01 — Tổng quan
                </span>
                <span className="landing-sample-badge">Dữ liệu minh họa</span>
              </div>
              <div className="landing-console-body">
                <ul
                  className="landing-hosts"
                  aria-label="Danh sách máy chủ mẫu"
                >
                  <li className="landing-host-row is-online">
                    <span className="landing-host-dot" aria-hidden="true" />
                    <span className="landing-host-name tnum">vps-prod-01</span>
                    <span className="landing-host-status">
                      Đang hoạt động
                    </span>
                    <span className="landing-host-meta tnum">
                      CPU 38% · RAM 62%
                    </span>
                  </li>
                  <li className="landing-host-row is-stale">
                    <span className="landing-host-dot" aria-hidden="true" />
                    <span className="landing-host-name tnum">
                      vps-staging-02
                    </span>
                    <span className="landing-host-status">Số liệu cũ</span>
                    <span className="landing-host-meta tnum">
                      CPU 12% · RAM 34%
                    </span>
                  </li>
                </ul>

                <div className="landing-metrics">
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">CPU</span>
                      <span className="landing-metric-value tnum">38%</span>
                    </div>
                    <div
                      className="landing-meter"
                      role="img"
                      aria-label="CPU mẫu 38 phần trăm"
                    >
                      <span
                        className="landing-meter-fill is-cpu"
                        style={{ width: "38%" }}
                      />
                    </div>
                    <span className="landing-metric-cap tnum">
                      4 vCPU · load 1.24
                    </span>
                  </div>
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">RAM</span>
                      <span className="landing-metric-value tnum">62%</span>
                    </div>
                    <div
                      className="landing-meter"
                      role="img"
                      aria-label="RAM mẫu 62 phần trăm"
                    >
                      <span
                        className="landing-meter-fill is-mem"
                        style={{ width: "62%" }}
                      />
                    </div>
                    <span className="landing-metric-cap tnum">
                      7.4 / 12 GiB
                    </span>
                  </div>
                  <div className="landing-metric">
                    <div className="landing-metric-head">
                      <span className="landing-metric-label">Ổ đĩa</span>
                      <span className="landing-metric-value tnum">41%</span>
                    </div>
                    <div
                      className="landing-meter"
                      role="img"
                      aria-label="Ổ đĩa mẫu 41 phần trăm"
                    >
                      <span
                        className="landing-meter-fill is-disk"
                        style={{ width: "41%" }}
                      />
                    </div>
                    <span className="landing-metric-cap tnum">82 / 200 GiB</span>
                  </div>
                </div>

                <div className="landing-panels">
                  <div className="landing-panel">
                    <p className="landing-panel-title">
                      <Activity size={15} aria-hidden="true" />
                      Lịch sử CPU · 60 phút mẫu
                    </p>
                    <svg
                      className="landing-chart"
                      viewBox="0 0 260 84"
                      role="img"
                      aria-label="Biểu đồ minh họa tĩnh: CPU dao động trong 60 phút mẫu"
                    >
                      <g aria-hidden="true">
                        <line
                          x1="0"
                          y1="21"
                          x2="260"
                          y2="21"
                          className="landing-chart-grid"
                        />
                        <line
                          x1="0"
                          y1="42"
                          x2="260"
                          y2="42"
                          className="landing-chart-grid"
                        />
                        <line
                          x1="0"
                          y1="63"
                          x2="260"
                          y2="63"
                          className="landing-chart-grid"
                        />
                        <polyline
                          points="0,50 22,46 44,48 66,40 88,42 110,34 132,37 154,30 176,33 198,26 220,30 242,24 260,27"
                          className="landing-chart-line is-cpu"
                        />
                      </g>
                    </svg>
                    <p className="landing-panel-meta">
                      <span className="landing-legend is-cpu">CPU</span>
                      <span className="tnum">uptime 42 ngày</span>
                    </p>
                  </div>
                  <div className="landing-panel">
                    <p className="landing-panel-title">
                      <TerminalSquare size={15} aria-hidden="true" />
                      Tác vụ mẫu gần đây
                    </p>
                    <ul className="landing-jobs">
                      <li className="landing-job-row">
                        <span className="landing-job-name tnum">
                          backup-nightly
                        </span>
                        <span className="landing-pill is-ok">Thành công</span>
                      </li>
                      <li className="landing-job-row">
                        <span className="landing-job-name tnum">
                          deploy-api · 62%
                        </span>
                        <span className="landing-pill is-run">Đang chạy</span>
                      </li>
                    </ul>
                    <p className="landing-panel-meta">
                      6 vùng chứa Docker · 128 bản ghi mẫu
                    </p>
                  </div>
                </div>
              </div>
              <figcaption className="landing-console-caption">
                Minh họa bố cục với số liệu tĩnh.
              </figcaption>
            </figure>
          </div>
        </section>

        <section
          className="landing-section"
          id="tinh-nang"
          aria-labelledby="landing-features-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Tính năng</p>
              <h2
                className="landing-section-title"
                id="landing-features-title"
              >
                Một nơi cho việc vận hành VPS mỗi ngày
              </h2>
              <p className="landing-section-sub">
                Những việc bạn làm được với bảng điều khiển.
              </p>
            </div>

            <ul className="landing-features">
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Activity size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Sức khỏe từng máy chủ
                  </h3>
                  <p className="landing-feature-desc">
                    Theo dõi CPU, RAM, ổ đĩa, mạng và thời gian hoạt động của
                    từng máy chủ. Thiếu số liệu thì hiển thị rõ, không tự điền
                    giá trị.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Container size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Docker trong mục riêng
                  </h3>
                  <p className="landing-feature-desc">
                    Kiểm tra vùng chứa Docker tách khỏi tình trạng máy chủ. Cần
                    cấp quyền cho agent mới xem được số liệu, chi tiết trong{" "}
                    <a
                      className="landing-inline-link"
                      href={SECURITY_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tài liệu bảo mật
                    </a>
                    .
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <TerminalSquare size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    SSH và tác vụ từ xa
                  </h3>
                  <p className="landing-feature-desc">
                    Cấp phát và xác minh khóa SSH cho từng máy chủ, chỉ kết nối
                    tới địa chỉ được cho phép. Chạy lệnh từ xa và theo dõi tiến
                    độ cùng kết quả rõ ràng cho từng tác vụ.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <History size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Lịch sử để đối chiếu
                  </h3>
                  <p className="landing-feature-desc">
                    Xem lại lịch sử số liệu và hoạt động đã ghi nhận để đối
                    chiếu khi cần. Số liệu cũ luôn kèm nhãn thời điểm rõ ràng.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Database size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Tự triển khai, dữ liệu của bạn
                  </h3>
                  <p className="landing-feature-desc">
                    Tự triển khai bảng điều khiển và chọn nơi lưu dữ liệu bằng
                    JSON hoặc PostgreSQL. Đổi chế độ không tự chuyển dữ liệu
                    demo thành dữ liệu máy chủ thật.
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="quy-trinh"
          aria-labelledby="landing-workflow-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Quy trình</p>
              <h2
                className="landing-section-title"
                id="landing-workflow-title"
              >
                Từ máy mới tới vận hành ổn định
              </h2>
              <p className="landing-section-sub">
                Chi tiết lệnh và tùy chọn xem trong{" "}
                <a
                  className="landing-inline-link"
                  href={README_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  README
                </a>{" "}
                và{" "}
                <a
                  className="landing-inline-link"
                  href={SECURITY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  mô hình bảo mật
                </a>
                .
              </p>
            </div>

            <ol className="landing-workflow">
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  01
                </span>
                <h3 className="landing-step-title">Cài đặt</h3>
                <p className="landing-step-desc">
                  Chạy từ mã nguồn, Docker Compose hoặc trình cài đặt Linux.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  02
                </span>
                <h3 className="landing-step-title">
                  Đặt mật khẩu và đăng nhập
                </h3>
                <p className="landing-step-desc">
                  Bật chế độ local, đặt mật khẩu bảng điều khiển rồi đăng nhập
                  để mở giao diện.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  03
                </span>
                <h3 className="landing-step-title">
                  Thêm máy chủ và tin cậy SSH
                </h3>
                <p className="landing-step-desc">
                  Thêm từng máy chủ rồi xác minh khóa trước khi kết nối thật.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  04
                </span>
                <h3 className="landing-step-title">
                  Gắn agent để có số liệu
                </h3>
                <p className="landing-step-desc">
                  Gắn agent cho từng máy chủ để số liệu bắt đầu đổ về bảng
                  điều khiển.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section
          className="landing-section"
          id="che-do"
          aria-labelledby="landing-modes-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Chế độ sử dụng</p>
              <h2 className="landing-section-title" id="landing-modes-title">
                Demo tự chạy, local cho hạ tầng thật
              </h2>
              <p className="landing-section-sub">
                Trang này không cung cấp demo công khai; bạn có thể tự chạy{" "}
                <code className="tnum">APP_MODE=demo</code> theo hướng dẫn rồi
                mở <code className="tnum">/vps</code> để trải nghiệm.
              </p>
            </div>

            <div className="landing-modes">
              <article className="landing-mode landing-mode-demo">
                <p className="landing-mode-title">
                  <Zap size={16} aria-hidden="true" />
                  Chế độ demo
                </p>
                <p className="landing-mode-code tnum">APP_MODE=demo</p>
                <p className="landing-mode-desc">
                  Bản mô phỏng đầy đủ máy chủ, số liệu, tác vụ và cửa sổ lệnh —
                  mở <code className="tnum">/vps</code> là thấy ngay. Không cần
                  máy chủ thật, không kết nối SSH thật, không cần đăng nhập.
                </p>
                <p className="landing-mode-note">
                  Phù hợp khám phá giao diện và chụp ảnh minh họa.
                </p>
              </article>
              <article className="landing-mode landing-mode-local">
                <p className="landing-mode-title">
                  <ShieldCheck size={16} aria-hidden="true" />
                  Chế độ local
                </p>
                <p className="landing-mode-code tnum">APP_MODE=local</p>
                <p className="landing-mode-desc">
                  Dữ liệu thật từ nơi lưu trữ và agent do bạn cấu hình, đăng
                  nhập bằng mật khẩu bảng điều khiển. Kết nối SSH chịu kiểm
                  soát, cửa sổ lệnh tắt mặc định và Docker không được cấp quyền
                  mặc định.
                </p>
                <p className="landing-mode-note">
                  Đọc{" "}
                  <a
                    className="landing-inline-link"
                    href={SECURITY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    mô hình bảo mật
                  </a>{" "}
                  trước khi mở truy cập.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="faq"
          aria-labelledby="landing-faq-title"
        >
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
                  <span>Chưa có máy chủ thật thì dùng thử được không?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Được. Bạn tự chạy{" "}
                  <code className="tnum">APP_MODE=demo</code> trên máy của mình
                  rồi mở <code className="tnum">/vps</code> để thấy bản mô
                  phỏng. Không cần SSH hay thông tin đăng nhập nào.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Trang này có demo công khai không?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Không. Trang này không cung cấp demo công khai; bạn có thể tự
                  chạy <code className="tnum">APP_MODE=demo</code> theo hướng
                  dẫn. Bản bạn tự triển khai ở chế độ local luôn yêu cầu mật
                  khẩu.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Dữ liệu của tôi được lưu ở đâu?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Ngay trên máy chủ đã cấu hình của bạn, bằng JSON hoặc
                  PostgreSQL theo cấu hình triển khai. Docker Compose lưu dữ
                  liệu trong các volume trên hạ tầng của bạn.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Cài đặt có những cách nào?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Ba cách: chạy từ mã nguồn, dựng bằng Docker Compose, hoặc
                  trình cài đặt Linux cho amd64. Chi tiết từng lệnh xem trong{" "}
                  <a
                    className="landing-inline-link"
                    href={README_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    README
                  </a>
                  .
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Kết nối tới máy chủ của tôi thế nào?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Thêm máy chủ từ bảng điều khiển, sau đó cấp phát hoặc xác
                  minh khóa SSH. Kết nối thật chỉ tới địa chỉ được cho phép và
                  cần tin cậy khóa máy chủ một cách tường minh; dải mạng riêng
                  bị chặn mặc định. Xem thêm{" "}
                  <a
                    className="landing-inline-link"
                    href={SECURITY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    mô hình bảo mật
                  </a>
                  .
                </p>
              </details>
            </div>
          </div>
        </section>

        <section
          className="landing-section"
          id="lien-he"
          aria-labelledby="landing-contact-title"
        >
          <div className="landing-wrap">
            <div className="landing-contact-panel">
              <p className="landing-section-eyebrow">Triển khai</p>
              <h2 className="landing-contact-title" id="landing-contact-title">
                Triển khai FlexServer trên hạ tầng của bạn
              </h2>
              <p className="landing-contact-sub">
                Hướng dẫn đầy đủ cách cài đặt, cấu hình và kết nối máy chủ nằm
                trong README.
              </p>
              <div className="landing-contact-actions">
                <a
                  className="landing-btn landing-btn-primary"
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Xem hướng dẫn triển khai
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
                <Link className="landing-btn landing-btn-secondary" to="/vps">
                  Mở bảng điều khiển
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

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
              Bảng điều khiển tự triển khai để quản lý nhiều máy chủ trong một
              nơi — theo dõi tài nguyên, kiểm tra Docker và quản lý tác vụ SSH.
            </p>
          </div>
          <nav className="landing-footer-col" aria-label="Sản phẩm">
            <p className="landing-footer-heading">Sản phẩm</p>
            <Link className="landing-footer-link" to="/vps">
              Bảng điều khiển
            </Link>
            <a className="landing-footer-link" href="#tinh-nang">
              Tính năng
            </a>
            <a className="landing-footer-link" href="#quy-trinh">
              Quy trình
            </a>
          </nav>
          <nav className="landing-footer-col" aria-label="Hỗ trợ">
            <p className="landing-footer-heading">Hỗ trợ</p>
            <a className="landing-footer-link" href="#faq">
              Câu hỏi thường gặp
            </a>
            <a
              className="landing-footer-link"
              href="https://github.com/sondoan17/vps-manager-nodejs/issues"
              target="_blank"
              rel="noreferrer"
            >
              Báo lỗi / góp ý
            </a>
            <a
              className="landing-footer-link"
              href={`mailto:${CONTACT_EMAIL}`}
            >
              {CONTACT_EMAIL}
            </a>
          </nav>
        </div>
        <div className="landing-wrap landing-footer-bottom">
          <p>© 2026 Sondoan Technology. FlexServer — quản lý VPS tập trung.</p>
        </div>
      </footer>
    </div>
  );
}
