export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
