export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new HttpError(404, message, details);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function payloadTooLarge(message: string, details?: unknown) {
  return new HttpError(413, message, details);
}

export function unsupportedMediaType(message: string, details?: unknown) {
  return new HttpError(415, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}

/** A first review-entry receipt retains its issue, company and pinned revisions. */
export function reviewEntryReceiptRetained(subject: "Company" | "Issue" | "Document", receiptId: string | null) {
  return conflict(
    `${subject} cannot be deleted because review-entry receipt ${receiptId ?? "evidence"} retains its evidence.`,
    { code: "review_entry_receipt_retained", receiptId },
  );
}

/** Integrity refusals are not optional diagnostic-write failures. */
export function reviewEntryFenceRefusalCode(error: unknown):
  "review_entry_writer_busy" | "review_entry_path_unverified" | null {
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    if ("code" in current && current.code === "55P03" &&
        "message" in current && current.message === "review_entry_writer_busy") {
      return "review_entry_writer_busy";
    }
    if (current instanceof HttpError && current.details !== null && typeof current.details === "object" &&
        "code" in current.details) {
      const code = current.details.code;
      if (code === "review_entry_writer_busy" || code === "review_entry_path_unverified") return code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}
