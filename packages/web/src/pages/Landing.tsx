import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  Container,
  Database,
  Globe,
  History,
  ListChecks,
  Menu,
  Network,
  Server,
  ShieldCheck,
  TerminalSquare,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import "./landing.css";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#audience", label: "Who it's for" },
  { href: "#architecture", label: "How it works" },
  { href: "#deploy", label: "Deploy" },
  { href: "#faq", label: "FAQ" },
];

const CONTACT_EMAIL = "contact@flexserver.tech";
const REPO_URL = "https://github.com/ArseneLupin0111/vps-manager-nodejs";
const README_URL = `${REPO_URL}#readme`;
const DEPLOY_URL = `${REPO_URL}#deploy-with-docker-compose`;
const SECURITY_URL = `${REPO_URL}/blob/main/docs/security.md`;
const ISSUES_URL = `${REPO_URL}/issues`;
const ARCHITECTURE_URL = `${REPO_URL}/blob/main/docs/architecture.md`;
const DEMO_GUIDE_URL = `${REPO_URL}/blob/main/docs/demo.md`;

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  // Pinned-hero storytelling: native document scroll only (no wheel
  // interception). While the hero scene is pinned, progress maps scroll to
  // CSS properties on the scene element; reduced motion and short/narrow
  // viewports keep the plain stacked flow.
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const media = window.matchMedia(
      "(min-width: 64rem) and (min-height: 40rem)"
    );
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let frame = 0;
    let unpinnedScroll = 0;
    let active = false;

    const reset = () => {
      scene.style.setProperty("--scene-progress", "0");
      scene.style.removeProperty("--preview-initial-top");
      scene.style.removeProperty("--preview-travel");
      scene.style.removeProperty("--preview-start-scale");
      scene.style.removeProperty("--preview-scale-delta");
      scene.removeAttribute("data-scene-active");
      scene.removeAttribute("data-scene-pinned");
      scene.removeAttribute("data-scene-copy-faded");
    };

    // Re-measure on media/preference/viewport changes, then repaint.
    const sync = () => {
      active = media.matches && !reduceMotion.matches;
      if (!active) {
        reset();
        return;
      }

      const stage = scene.querySelector<HTMLElement>(".landing-hero-stage");
      const metaEl = scene.querySelector<HTMLElement>(".landing-hero-meta");
      const copyEl = scene.querySelector<HTMLElement>(
        ".landing-hero-stage-copy"
      );
      const previewWrap = scene.querySelector<HTMLElement>(
        ".landing-hero-preview-wrap"
      );

      // Measure capability row bottom with extra 40px gap so preview does not
      // collide with highlights row at initial flow.
      let initialTop = 420;
      if (stage && metaEl) {
        const stageRect = stage.getBoundingClientRect();
        const metaRect = metaEl.getBoundingClientRect();
        initialTop = Math.round(metaRect.bottom - stageRect.top + 40);
      } else if (copyEl) {
        initialTop = Math.round(copyEl.offsetHeight + 40);
      }

      // Fit shorter desktop heights (e.g. 900, 768, 640): scale preview so the
      // entire console + caption + caveat fits the sticky stage at end.
      const headerH = 72;
      const stageH = window.innerHeight - headerH;
      const availableH = stageH - 36;
      const previewH = previewWrap ? previewWrap.offsetHeight : 770;

      // Safe static fallback if viewport cannot fit scaled preview comfortably
      if (window.innerHeight < 600 || availableH / previewH < 0.6) {
        active = false;
        reset();
        return;
      }

      scene.setAttribute("data-scene-active", "");
      scene.style.setProperty("--scene-progress", "0");

      const endScale = Math.min(1, Number((availableH / previewH).toFixed(3)));
      const startScale = Number((endScale * 0.95).toFixed(3));
      const scaleDelta = Number((endScale - startScale).toFixed(3));
      const scaledH = previewH * endScale;

      // Vertically center final preview in sticky stage with ~24px top bound
      const targetTop = Math.max(16, Math.round((stageH - scaledH) / 2));
      const travel = Math.max(0, initialTop - targetTop);

      scene.style.setProperty("--preview-initial-top", `${initialTop}px`);
      scene.style.setProperty("--preview-travel", `${travel}px`);
      scene.style.setProperty("--preview-start-scale", `${startScale}`);
      scene.style.setProperty("--preview-scale-delta", `${scaleDelta}`);

      // Guard: if the scene can't pin (e.g. height collapses), bail out.
      unpinnedScroll = scene.offsetHeight - window.innerHeight;
      if (unpinnedScroll <= 0) {
        active = false;
        reset();
        return;
      }
      render();
    };

    const render = () => {
      frame = 0;
      if (!active || unpinnedScroll <= 0) return;
      const rect = scene.getBoundingClientRect();
      const top = rect.top;
      // Progress 0 while the scene is still entering, 1 once it unpins.
      const progress = Math.min(1, Math.max(0, -top / unpinnedScroll));
      scene.style.setProperty("--scene-progress", progress.toFixed(4));
      scene.toggleAttribute("data-scene-pinned", progress > 0 && progress < 1);
      scene.toggleAttribute("data-scene-copy-faded", progress >= 0.85);
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    media.addEventListener("change", sync);
    reduceMotion.addEventListener("change", sync);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", sync);
    sync();

    return () => {
      media.removeEventListener("change", sync);
      reduceMotion.removeEventListener("change", sync);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", sync);
      if (frame) window.cancelAnimationFrame(frame);
      reset();
    };
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <div className="landing-page" id="top" lang="en">
      <a className="landing-skip" href="#main-content">
        Skip to main content
      </a>

      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a
            className="landing-brand"
            href="#top"
            onClick={() => setMenuOpen(false)}
            aria-label="FlexServer — back to top"
          >
            <span className="landing-brand-mark" aria-hidden="true">
              <Server size={18} strokeWidth={2.25} />
            </span>
            <span className="landing-brand-text">
              <span className="landing-brand-name">FlexServer</span>
              <span className="landing-brand-sub">by FlexTechnology</span>
            </span>
          </a>

          <nav className="landing-nav" aria-label="Primary">
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
            <a
              className="landing-btn landing-btn-primary landing-btn-small"
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
            >
              Deployment docs
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="landing-menu-button"
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              aria-label={
                menuOpen ? "Close navigation menu" : "Open navigation menu"
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
            <nav aria-label="Mobile">
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
              <a
                className="landing-btn landing-btn-primary landing-btn-block"
                href={DEPLOY_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
              >
                Deployment docs
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
              <a
                className="landing-btn landing-btn-secondary landing-btn-block"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
              >
                GitHub repository
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : null}
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <div className="landing-hero-scene" ref={sceneRef}>
            <div className="landing-hero-stage">
              <div className="landing-wrap landing-hero-stage-copy">
                <div className="landing-hero-copy">
                  <p className="landing-eyebrow">
                    <span className="landing-eyebrow-dot" aria-hidden="true" />
                    Self-hosted VPS operations dashboard
                  </p>
                <h1 className="landing-hero-title" id="landing-hero-title">
                  Modern VPS Management
                </h1>
                <p className="landing-hero-sub">
                  Server health, Docker and SSH jobs. One workspace, on your
                  infrastructure.
                </p>
                <div className="landing-hero-ctas">
                  <a
                    className="landing-btn landing-btn-primary"
                    href={DEPLOY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the deployment docs
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </a>
                  <a
                    className="landing-btn landing-btn-secondary"
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Browse on GitHub
                  </a>
                </div>
              </div>
  
              <ul className="landing-hero-meta" aria-label="Highlights">
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Many servers in one place
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Per-host resource history
                </li>
                <li className="landing-hero-meta-item">
                  <Check size={15} aria-hidden="true" />
                  Deploys on your infrastructure
                </li>
              </ul>
            </div>

            <div className="landing-wrap landing-hero-preview-wrap">
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
                    vps-prod-01 — Overview
                  </span>
                  <span className="landing-sample-badge">Sample data</span>
                </div>
                <div className="landing-console-body">
                  <ul
                    className="landing-hosts"
                    aria-label="Sample server list"
                  >
                    <li className="landing-host-row is-online">
                      <span className="landing-host-dot" aria-hidden="true" />
                      <span className="landing-host-name tnum">vps-prod-01</span>
                      <span className="landing-host-status">
                        Online
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
                      <span className="landing-host-status">Stale data</span>
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
                        aria-label="Sample CPU at 38 percent"
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
                        aria-label="Sample memory at 62 percent"
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
                        <span className="landing-metric-label">Disk</span>
                        <span className="landing-metric-value tnum">41%</span>
                      </div>
                      <div
                        className="landing-meter"
                        role="img"
                        aria-label="Sample disk at 41 percent"
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
                        CPU history · 60 sample minutes
                      </p>
                      <svg
                        className="landing-chart"
                        viewBox="0 0 260 84"
                        role="img"
                        aria-label="Static sample chart: CPU moves between 30 and 55 percent over 60 sample minutes"
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
                        <span className="tnum">uptime 42 days</span>
                      </p>
                    </div>
                    <div className="landing-panel">
                      <p className="landing-panel-title">
                        <TerminalSquare size={15} aria-hidden="true" />
                        Recent sample jobs
                      </p>
                      <ul className="landing-jobs">
                        <li className="landing-job-row">
                          <span className="landing-job-name tnum">
                            backup-nightly
                          </span>
                          <span className="landing-pill is-ok">Succeeded</span>
                        </li>
                        <li className="landing-job-row">
                          <span className="landing-job-name tnum">
                            deploy-api · 62%
                          </span>
                          <span className="landing-pill is-run">Running</span>
                        </li>
                      </ul>
                      <p className="landing-panel-meta">
                        6 Docker containers · 128 sample records
                      </p>
                    </div>
                  </div>
                </div>
                <figcaption className="landing-console-caption">
                  Static layout illustration with sample numbers. It is not live
                  telemetry and never connects to your servers.
                </figcaption>
              </figure>
              <p className="landing-hero-caveat">
                No hosted account, no third-party data store. This page is
                informational only and offers no public demo: run your own
                deployment in demo mode to explore with simulated data, or in
                local mode to manage real servers.
              </p>
            </div>

            <p className="landing-hero-scene-hint" aria-hidden="true">
              <ChevronDown size={16} strokeWidth={2.25} />
              Scroll to focus the dashboard
            </p>
          </div>
        </div>
      </section>

        <section
          className="landing-section"
          id="features"
          aria-labelledby="landing-features-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Features</p>
              <h2
                className="landing-section-title"
                id="landing-features-title"
              >
                One place for everyday VPS operations
              </h2>
              <p className="landing-section-sub">
                Concrete capabilities you get after you deploy the dashboard on
                your own infrastructure. Everything below describes the
                dashboard you run — not a service hosted by FlexTechnology.
              </p>
            </div>

            <ul className="landing-features">
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Activity size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Per-host health you can read at a glance
                  </h3>
                  <p className="landing-feature-desc">
                    Track CPU, memory, disk, system load, network throughput,
                    and uptime for every server. Bounded per-host history feeds
                    the overview and metrics views, and missing samples render
                    as explicit gaps or “unavailable” instead of invented
                    values.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Container size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Docker checks in their own tab
                  </h3>
                  <p className="landing-feature-desc">
                    Container counts stay separate from host health, so a
                    stopped container is never misread as a down server. Docker
                    monitoring needs an agent snapshot and stays independent
                    from management actions; see the{" "}
                    <a
                      className="landing-inline-link"
                      href={SECURITY_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      security model
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
                    SSH keys, command jobs, and an optional terminal
                  </h3>
                  <p className="landing-feature-desc">
                    Provision and verify an SSH key per server, then run remote
                    commands as tracked jobs with progress and results.
                    Real SSH only targets allowed addresses with explicit host
                    key trust; the web terminal ships disabled and needs
                    local-mode configuration.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <History size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    History and audit trail for follow-up
                  </h3>
                  <p className="landing-feature-desc">
                    Revisit retained CPU and memory samples, network RX/TX in
                    bytes per second, job outcomes with failure reasons, and
                    the audit log when you need to compare what changed.
                    Stale data keeps an explicit timestamp label.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Database size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Your deployment, your data
                  </h3>
                  <p className="landing-feature-desc">
                    Self-host the dashboard and keep data in JSON files or
                    PostgreSQL (optional TimescaleDB). Switching modes never
                    converts simulated demo records into real server data.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <ShieldCheck size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Guardrails are on by default
                  </h3>
                  <p className="landing-feature-desc">
                    Demo mode disables real SSH, private-network targets are
                    blocked unless explicitly allowed in local mode, and the
                    systemd agent gets no Docker socket access unless you opt
                    in. Read the{" "}
                    <a
                      className="landing-inline-link"
                      href={SECURITY_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      security model
                    </a>{" "}
                    before opening SSH, terminal, or Docker access.
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="audience"
          aria-labelledby="landing-audience-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Who it is for</p>
              <h2
                className="landing-section-title"
                id="landing-audience-title"
              >
                Built for small teams running their own servers
              </h2>
              <p className="landing-section-sub">
                FlexServer fits operators who already SSH into machines and
                want one calm place to check health, jobs, and history —
                without handing data to a third party.
              </p>
            </div>

            <ul className="landing-features landing-audience">
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Users size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Solo developers and small ops teams
                  </h3>
                  <p className="landing-feature-desc">
                    Keep your Linux hosts visible in one workspace for daily
                    health checks, tracked command jobs, and follow-up using
                    metrics and audit history.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Boxes size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    Homelab and self-hosting users
                  </h3>
                  <p className="landing-feature-desc">
                    Run the whole stack with Docker Compose or from source,
                    keep data in local JSON files or Postgres volumes, and
                    explore safely first with simulated demo data.
                  </p>
                </div>
              </li>
              <li className="landing-feature">
                <span className="landing-feature-icon" aria-hidden="true">
                  <Globe size={20} />
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">
                    What it is not
                  </h3>
                  <p className="landing-feature-desc">
                    Not a hosted monitoring SaaS, not an alerting or
                    auto-scaling platform, and not a replacement for backups,
                    firewalls, or access reviews. It shows what your servers
                    report; your team still decides what to do.
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section
          className="landing-section"
          id="architecture"
          aria-labelledby="landing-arch-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">How it works</p>
              <h2 className="landing-section-title" id="landing-arch-title">
                Browser, API, storage, and agent
              </h2>
              <p className="landing-section-sub">
                Four parts with clear responsibilities. Full component and
                data-flow notes live in the{" "}
                <a
                  className="landing-inline-link"
                  href={ARCHITECTURE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  architecture doc
                </a>
                .
              </p>
            </div>

            <ol className="landing-workflow landing-arch">
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  01
                </span>
                <h3 className="landing-step-title">
                  <Network size={16} aria-hidden="true" /> Web workspace
                </h3>
                <p className="landing-step-desc">
                  Vite + React views for servers, metrics, Docker, SSH, jobs,
                  history, and settings. Static preview only — no live
                  connections from this page.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  02
                </span>
                <h3 className="landing-step-title">
                  <Workflow size={16} aria-hidden="true" /> API and jobs
                </h3>
                <p className="landing-step-desc">
                  Express + NestJS API serves the dashboard, runs SSH command
                  jobs over allow-listed targets, and records metrics, job,
                  and audit history.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  03
                </span>
                <h3 className="landing-step-title">
                  <Database size={16} aria-hidden="true" /> Your storage
                </h3>
                <p className="landing-step-desc">
                  JSON files under your data directory by default, or
                  PostgreSQL with optional TimescaleDB. Docker volumes keep
                  database data and private keys on your host.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  04
                </span>
                <h3 className="landing-step-title">
                  <ListChecks size={16} aria-hidden="true" /> Server agent
                </h3>
                <p className="landing-step-desc">
                  Optional Go agent on each Linux host reports CPU, memory,
                  disk, and Docker snapshots. Docker metrics stay opt-in;
                  management actions remain separate and confirmed.
                </p>
              </li>
            </ol>

            <p className="landing-arch-flow" role="note">
              Data flow: browser web {"→"} NestJS API {"→"} JSON or
              PostgreSQL storage + SSH/agent collection. The API never opens
              a Docker socket itself; only the on-host agent can read Docker,
              and only when you enable it.
            </p>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="workflow"
          aria-labelledby="landing-workflow-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Workflow</p>
              <h2
                className="landing-section-title"
                id="landing-workflow-title"
              >
                From a new machine to steady operations
              </h2>
              <p className="landing-section-sub">
                Exact commands and options live in the{" "}
                <a
                  className="landing-inline-link"
                  href={README_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  README
                </a>{" "}
                and the{" "}
                <a
                  className="landing-inline-link"
                  href={SECURITY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  security model
                </a>
                .
              </p>
            </div>

            <ol className="landing-workflow">
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  01
                </span>
                <h3 className="landing-step-title">Install</h3>
                <p className="landing-step-desc">
                  Run from source, with Docker Compose, or with the Linux
                  installer on amd64.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  02
                </span>
                <h3 className="landing-step-title">
                  Set a password and sign in
                </h3>
                <p className="landing-step-desc">
                  Enable local mode, set the dashboard password, then sign in
                  to open the workspace.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  03
                </span>
                <h3 className="landing-step-title">
                  Add servers and trust SSH
                </h3>
                <p className="landing-step-desc">
                  Add each host, then provision or verify its SSH key with
                  explicit host-key trust before real connections.
                </p>
              </li>
              <li className="landing-step">
                <span className="landing-step-num tnum" aria-hidden="true">
                  04
                </span>
                <h3 className="landing-step-title">
                  Attach agents for metrics
                </h3>
                <p className="landing-step-desc">
                  Attach an agent per host to collect resource samples. Enable
                  Docker permissions separately when you need container snapshots.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section
          className="landing-section"
          id="deploy"
          aria-labelledby="landing-modes-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Deploy</p>
              <h2 className="landing-section-title" id="landing-modes-title">
                Self-run demo, local mode for real infrastructure
              </h2>
              <p className="landing-section-sub">
                There is no public demo on this page. Run{" "}
                <code className="tnum">APP_MODE=demo</code> yourself to explore
                with simulated data, or choose local mode for real servers.
                Deployment presets and commands are in the{" "}
                <a
                  className="landing-inline-link"
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  deployment docs
                </a>
                .
              </p>
            </div>

            <ul className="landing-deploy-list" aria-label="Deployment options">
              <li className="landing-deploy-item">
                <BookOpen size={18} aria-hidden="true" />
                <div>
                  <h3>From source</h3>
                  <p>
                    Node 22 recommended. API on port 3001, web workspace on
                    3000, JSON storage by default.
                  </p>
                </div>
              </li>
              <li className="landing-deploy-item">
                <BookOpen size={18} aria-hidden="true" />
                <div>
                  <h3>Docker Compose</h3>
                  <p>
                    Postgres with optional TimescaleDB, migrate, API, and web
                    services on loopback ports. Volumes keep database data and
                    private keys on your host.
                  </p>
                </div>
              </li>
              <li className="landing-deploy-item">
                <BookOpen size={18} aria-hidden="true" />
                <div>
                  <h3>Linux installer</h3>
                  <p>
                    For Linux amd64 hosts with systemd, sudo, and Docker when
                    you want the agent alongside the dashboard.
                  </p>
                </div>
              </li>
            </ul>

            <div className="landing-modes">
              <article className="landing-mode landing-mode-demo">
                <p className="landing-mode-title">
                  <Zap size={16} aria-hidden="true" />
                  Demo mode
                </p>
                <p className="landing-mode-code tnum">APP_MODE=demo</p>
                <p className="landing-mode-desc">
                  A full simulation of servers, metrics, jobs, and the command
                  window for exploring the interface on your own machine. No
                  real servers, no real SSH connections, no sign-in.
                </p>
                <p className="landing-mode-note">
                  Good for learning the layout and taking sample screenshots.
                  See the{" "}
                  <a
                    className="landing-inline-link"
                    href={DEMO_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    demo guide
                  </a>
                  .
                </p>
              </article>
              <article className="landing-mode landing-mode-local">
                <p className="landing-mode-title">
                  <ShieldCheck size={16} aria-hidden="true" />
                  Local mode
                </p>
                <p className="landing-mode-code tnum">APP_MODE=local</p>
                <p className="landing-mode-desc">
                  Real data from storage and agents you configure, protected
                  by the dashboard password. SSH connections are controlled,
                  the web terminal is off by default, and Docker gets no
                  access by default.
                </p>
                <p className="landing-mode-note">
                  Read the{" "}
                  <a
                    className="landing-inline-link"
                    href={SECURITY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    security model
                  </a>{" "}
                  before opening access. Switching modes is not a migration:
                  demo records never become production data.
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
              <p className="landing-section-eyebrow">FAQ</p>
              <h2 className="landing-section-title" id="landing-faq-title">
                Quick answers before you deploy
              </h2>
              <p className="landing-section-sub">
                Still unsure? Open an{" "}
                <a
                  className="landing-inline-link"
                  href={ISSUES_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  issue on GitHub
                </a>{" "}
                or mail{" "}
                <a
                  className="landing-inline-link"
                  href={`mailto:${CONTACT_EMAIL}`}
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </div>

            <div className="landing-faq">
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Can I try it without a real server?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Yes. Run{" "}
                  <code className="tnum">APP_MODE=demo</code> on your own
                  machine to explore a full simulation of servers, metrics,
                  jobs, and the command window. No SSH and no credentials are
                  needed. See the{" "}
                  <a
                    className="landing-inline-link"
                    href={DEMO_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    demo guide
                  </a>
                  .
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Is there a public demo on this page?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  No. This page offers no public demo and links only to docs
                  and source. Your own local deployment always requires the
                  dashboard password.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Where does my data live?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  On infrastructure you configure, as JSON files or in
                  PostgreSQL depending on the deployment. With Docker Compose,
                  data stays in volumes on your host.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>What are the install options?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Three ways: run from source, compose the Postgres/API/web
                  stack, or use the Linux installer for amd64. Each command is
                  in the{" "}
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
                  <span>How does it connect to my servers?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Add each server from the dashboard, then provision or verify
                  its SSH key. Real connections only go to allowed addresses
                  with explicit host-key trust, and private ranges stay
                  blocked by default. Details are in the{" "}
                  <a
                    className="landing-inline-link"
                    href={SECURITY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    security model
                  </a>
                  .
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>What about Docker and the web terminal?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Docker monitoring is opt-in through the on-host agent and is
                  separate from management actions. The web terminal is
                  disabled by default and needs explicit local-mode setup.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Does switching modes migrate my data?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  No. Switching between demo and local is not a migration path:
                  simulated records never convert into production data. Pick
                  the mode that matches what you want to manage.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section
          className="landing-section"
          id="contact"
          aria-labelledby="landing-contact-title"
        >
          <div className="landing-wrap">
            <div className="landing-contact-panel">
              <p className="landing-section-eyebrow">Deploy</p>
              <h2 className="landing-contact-title" id="landing-contact-title">
                Deploy FlexServer on your infrastructure
              </h2>
              <p className="landing-contact-sub">
                Full install, configuration, and server-connection steps are in
                the README and deployment docs. Questions go to GitHub issues
                or {CONTACT_EMAIL}.
              </p>
              <div className="landing-contact-actions">
                <a
                  className="landing-btn landing-btn-primary"
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the deployment docs
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
                <a
                  className="landing-btn landing-btn-secondary"
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Browse on GitHub
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
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
                <span className="landing-brand-sub">by FlexTechnology</span>
              </span>
            </span>
            <p className="landing-footer-tagline">
              A self-hosted dashboard for many servers in one place — resource
              tracking, Docker checks, and SSH jobs.
            </p>
          </div>
          <nav className="landing-footer-col" aria-label="Product">
            <p className="landing-footer-heading">Product</p>
            <a className="landing-footer-link" href="#features">
              Features
            </a>
            <a className="landing-footer-link" href="#audience">
              Who it is for
            </a>
            <a className="landing-footer-link" href="#architecture">
              How it works
            </a>
            <a className="landing-footer-link" href="#deploy">
              Deploy
            </a>
            <a
              className="landing-footer-link"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              GitHub repository
            </a>
          </nav>
          <nav className="landing-footer-col" aria-label="Support">
            <p className="landing-footer-heading">Support</p>
            <a className="landing-footer-link" href="#faq">
              FAQ
            </a>
            <a
              className="landing-footer-link"
              href={ISSUES_URL}
              target="_blank"
              rel="noreferrer"
            >
              Report an issue
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
          <p>© 2026 FlexTechnology. FlexServer — centralized VPS operations.</p>
        </div>
      </footer>
    </div>
  );
}
