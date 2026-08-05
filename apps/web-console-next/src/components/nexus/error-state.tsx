"use client";

/**
 * The one way a nexus surface reports a failure.
 *
 * Every page used to render `{error.code}` in red above `{error.message}` —
 * a wire enum on the page. This renders `presentApiError`'s human copy instead,
 * and offers a retry only when retrying could plausibly help.
 *
 * It is visually an error, not an empty state, and that distinction is
 * load-bearing: an unreadable board must never look like a clear one. See the
 * note on `presentApiError`.
 */

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { presentApiError } from "./nexus";

export interface NexusErrorStateProps {
  error: { code: string; message?: string };
  /** What the page was trying to load, e.g. "your exposure board". */
  surface?: string;
  onRetry?: (() => void) | undefined;
}

export function NexusErrorState({ error, surface, onRetry }: NexusErrorStateProps) {
  const presented = presentApiError(error, surface ? { surface } : {});
  return (
    <Card data-testid="nexus-error" className="border-destructive/40">
      <CardContent className="flex gap-3 p-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="space-y-2">
          <div className="font-medium">{presented.title}</div>
          <p className="text-sm text-muted-foreground">{presented.body}</p>
          {presented.retryable && onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Try again
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
