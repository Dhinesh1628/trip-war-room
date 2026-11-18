// One error shape for the whole API: { error: { code, message, details? } }.
// Throw an HttpError anywhere in a route; the error handler in app.js turns it
// into a response. Express 5 forwards rejected promises automatically.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'VALIDATION_FAILED', message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new HttpError(409, code, message);
