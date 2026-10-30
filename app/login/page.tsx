"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { safeReturnTo } from "../../worker/return-to.js";
import { BrandMark } from "../brand-mark";
import "../renewal.css";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [returnTo] = useState(() => typeof window === "undefined" ? "/" : safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "로그인하지 못했습니다.");
      window.location.assign(returnTo);
    } catch (loginError) {
      setError((loginError as Error).message);
      setSubmitting(false);
    }
  }

  return <main className="login-shell">
    <section className="login-card" aria-labelledby="login-title">
      <Link className="login-brand" href="/" prefetch={false} aria-label="집장부 홈">
        <BrandMark className="brand-mark login-logo" />
        <strong>집장부</strong>
      </Link>
      <div className="login-heading">
        <h1 id="login-title">로그인</h1>
        <span>마전현대공인중개사무소</span>
      </div>
      <form className="login-form" onSubmit={submit}>
        <label htmlFor="username">아이디 <b className="required-mark" aria-hidden="true">*</b></label>
        <input id="username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <label htmlFor="password">비밀번호 <b className="required-mark" aria-hidden="true">*</b></label>
        <input id="password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" disabled={submitting}>{submitting ? "확인 중…" : "로그인"}</button>
      </form>
    </section>
  </main>;
}
