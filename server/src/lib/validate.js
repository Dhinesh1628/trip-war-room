import mongoose from 'mongoose';
import { badRequest, notFound } from './errors.js';

// Turns zod issues into a short list a client can show next to form fields.
export function formatIssues(issues) {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

// Validates (and cleans) one part of the request with a zod schema.
// The cleaned value is stored on req.valid.body / req.valid.query, because
// Express 5 makes req.query read-only.
export function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      return next(badRequest('Request is invalid', formatIssues(result.error.issues)));
    }
    req.valid = { ...(req.valid || {}), [part]: result.data };
    next();
  };
}

// Throws a 404 (not a 500) for ids that are not valid ObjectIds.
export function assertObjectId(id, what = 'Resource') {
  if (!mongoose.isValidObjectId(id)) throw notFound(`${what} not found`);
}
