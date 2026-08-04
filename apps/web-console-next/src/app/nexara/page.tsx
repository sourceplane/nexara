"use client";

/**
 * The public storefront.
 *
 * Unauthenticated by design — it sits outside the `(app)` group and touches no
 * session. Self-serve signup hands off to `/login`, which is the platform's
 * existing passwordless + OAuth flow; a second credential path on a marketing
 * page is a second thing to get wrong.
 *
 * All copy comes from `@/components/nexara/storefront`, where a test asserts
 * no headline promises to file, to advise, or to guarantee compliance. See
 * that file for why.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRODUCT_NAME, SALES_EMAIL } from "@/lib/app-config";
import {
  EVIDENCE_STEPS,
  FEATURES,
  HERO,
  NON_GOALS,
} from "@/components/nexara/storefront";

export default function StorefrontPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:py-20">
      <header className="flex items-center justify-between pb-16">
        <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href={HERO.primaryCta.href}>{HERO.primaryCta.label}</Link>
          </Button>
        </nav>
      </header>

      <section className="max-w-3xl space-y-5">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">{HERO.eyebrow}</p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          {HERO.headline}
        </h1>
        <p className="text-lg text-muted-foreground">{HERO.subhead}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild size="lg">
            <Link href={HERO.primaryCta.href}>
              {HERO.primaryCta.label}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={HERO.secondaryCta.href}>{HERO.secondaryCta.label}</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 pt-20 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="space-y-1.5">
            <h2 className="flex items-start gap-2 font-medium">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              {f.title}
            </h2>
            <p className="pl-6 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>

      <section id="evidence" className="space-y-6 pt-20">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            How a position is proven
          </h2>
          <p className="text-muted-foreground">
            Four artefacts, each stored, each inspectable. If an auditor asks why your board says
            what it says, this is the answer — not a screenshot.
          </p>
        </div>
        <ol className="grid gap-4 sm:grid-cols-2">
          {EVIDENCE_STEPS.map((s) => (
            <li key={s.title} className="rounded-lg border bg-card p-4">
              <h3 className="font-medium">{s.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4 pt-20">
        <h2 className="text-2xl font-semibold tracking-tight">What {PRODUCT_NAME} is not</h2>
        <p className="max-w-2xl text-muted-foreground">
          Stated here rather than in a contract, because the boundary is worth knowing before you
          sign rather than after.
        </p>
        <ul className="space-y-2">
          {NON_GOALS.map((n) => (
            <li key={n} className="flex items-start gap-2 text-sm">
              <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-20 rounded-xl border bg-card p-8 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          Connect a channel and see your board
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-muted-foreground">
          No card required to start. Positions appear as soon as the first backfill lands.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link href={HERO.primaryCta.href}>{HERO.primaryCta.label}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href={`mailto:${SALES_EMAIL}`}>Talk to us</a>
          </Button>
        </div>
      </section>

      <footer className="mt-16 border-t pt-6 text-xs text-muted-foreground">
        {PRODUCT_NAME} measures your sales activity against published economic-nexus thresholds.
        It is not tax advice, and it does not file on your behalf.
      </footer>
    </div>
  );
}
