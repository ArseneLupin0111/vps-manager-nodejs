import { describe, expect, it } from "vitest";
import { validateBackendUrl } from "../src/scripts/bootstrap-local-updater.js";

describe("bootstrap-local-updater URL validation", () => {
  it("accepts https for any host", () => {
    expect(validateBackendUrl("https://api.example.com:8443").origin).toBe(
      "https://api.example.com:8443",
    );
  });

  it("accepts http for loopback hosts", () => {
    for (const url of [
      "http://127.0.0.1:3000",
      "http://localhost:3000/api",
      "http://[::1]:3000",
    ]) {
      expect(validateBackendUrl(url).protocol).toBe("http:");
    }
  });

  it("rejects http for non-loopback hosts with no override available", () => {
    for (const url of [
      "http://192.168.1.10:3000",
      "http://example.com:3000",
      "http://0.0.0.0:3000",
    ]) {
      expect(() => validateBackendUrl(url)).toThrow(/Insecure backend URL/);
    }
  });

  it("rejects invalid URLs and non-http(s) protocols", () => {
    expect(() => validateBackendUrl("not-a-url")).toThrow(
      /Invalid backend URL/,
    );
    expect(() => validateBackendUrl("ftp://example.com")).toThrow(
      /must use http or https/,
    );
  });
});
