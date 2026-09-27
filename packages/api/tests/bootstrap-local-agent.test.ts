import { describe, it, expect } from "vitest";
import { validateBackendUrl } from "../src/scripts/bootstrap-local-agent.js";

describe("bootstrap-local-agent URL validation", () => {
  it("accepts https URLs", () => {
    const url = validateBackendUrl("https://example.com:3000/api");
    expect(url.origin).toBe("https://example.com:3000");
  });

  it("accepts https with path", () => {
    const url = validateBackendUrl("https://api.example.com/v2");
    expect(url.pathname).toBe("/v2");
  });

  it("accepts http for loopback localhost", () => {
    const url = validateBackendUrl("http://localhost:3000");
    expect(url.hostname).toBe("localhost");
  });

  it("accepts http for loopback 127.0.0.1", () => {
    const url = validateBackendUrl("http://127.0.0.1:3001/api");
    expect(url.hostname).toBe("127.0.0.1");
  });

  it("accepts http for loopback ::1", () => {
    const url = validateBackendUrl("http://[::1]:3000");
    // Function normalizes IPv6 brackets, but URL.hostname may vary by Node version
    expect(url.hostname.replace(/^\[|\]$/g, "")).toBe("::1");
  });

  it("rejects http for unspecified 0.0.0.0", () => {
    expect(() => validateBackendUrl("http://0.0.0.0:3000")).toThrow(
      /Insecure backend URL/,
    );
  });

  it("rejects http for non-loopback IP", () => {
    expect(() => validateBackendUrl("http://192.168.1.1:3000")).toThrow(
      /Insecure backend URL/,
    );
  });

  it("rejects http for non-loopback hostname", () => {
    expect(() => validateBackendUrl("http://example.com:3000")).toThrow(
      /Insecure backend URL/,
    );
  });

  it("rejects http for non-loopback even when a second argument is passed", () => {
    // Regression: the removed allow-insecure override must not come back —
    // extra positional arguments are silently accepted by JS, so pin it.
    expect(() =>
      validateBackendUrl("http://192.168.1.1:3000", true as never),
    ).toThrow(/Insecure backend URL/);
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateBackendUrl("not-a-url")).toThrow(
      /Invalid backend URL/,
    );
  });

  it("rejects unsupported protocols", () => {
    expect(() => validateBackendUrl("ftp://example.com")).toThrow(
      /must use http or https/,
    );
  });

  it("preserves trailing path", () => {
    const url = validateBackendUrl("https://example.com/api/v1/metrics");
    expect(url.pathname).toBe("/api/v1/metrics");
  });

  it("preserves port", () => {
    const url = validateBackendUrl("https://example.com:8443");
    expect(url.port).toBe("8443");
  });
});
