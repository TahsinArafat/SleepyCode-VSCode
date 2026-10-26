/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Opaque, conversation-owned terminal transcript reference; never a filesystem path. */
export interface ToolOutputReference {
  id: string;
  available: boolean;
  /** The retained transcript is incomplete, for example after the disk limit. */
  truncated: boolean;
  /** UTF-8 bytes retained on disk (including writes currently being flushed). */
  bytes: number;
  /** Retention deadline in milliseconds since the Unix epoch; capacity can evict earlier. */
  expiresAt: number;
}

/** Machine-readable execution result, independent of text printed by a command. */
export interface ToolOutcome {
  /** This tool invocation's outcome; cancelling a wait need not kill its process. */
  status: "running" | "completed" | "failed" | "aborted" | "timed_out";
  /** Actual state of the referenced terminal process, when the outcome observes a job. */
  processStatus?: ToolOutcome["status"];
  exitCode?: number;
  jobId?: string;
  outputRef?: ToolOutputReference;
}
