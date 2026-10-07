import test from "node:test";
import assert from "node:assert/strict";

import {
  NetworkPolicyError,
  isPublicAddress,
  validateUrlShape,
} from "../src/network-policy.mjs";

test("private and special IPv4 ranges fail closed", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

test("IPv6 private, mapped, documentation and multicast ranges fail closed", () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("URL policy rejects local names, credentials, unsafe schemes and alternate loopback notation", () => {
  for (const value of [
    "file:///etc/passwd",
    "data:text/html,hello",
    "javascript:alert(1)",
    "http://localhost/",
    "http://app.internal/",
    "http://router/",
    "http://user:secret@example.com/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://[::1]/",
    "https://example.com:8443/",
  ]) {
    assert.throws(() => validateUrlShape(value), NetworkPolicyError, value);
  }
});

test("URL policy permits canonical public web URLs only on standard ports", () => {
  const https = validateUrlShape("https://example.com/path?q=1");
  assert.equal(https.host, "example.com");
  assert.equal(https.port, 443);

  const http = validateUrlShape("http://example.com/");
  assert.equal(http.port, 80);
});

test("loopback exception exists only for explicit test mode", () => {
  assert.throws(() => validateUrlShape("http://127.0.0.1:4567/"));
  const local = validateUrlShape("http://127.0.0.1:4567/", {
    allowLoopbackForTest: true,
  });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.port, 4567);
});
