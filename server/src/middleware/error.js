import { HttpError } from '../utils/httpError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.name === 'ValidationError') {
    return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(', ') });
  }
  if (err?.name === 'CastError') return res.status(400).json({ error: `Invalid value for ${err.path}` });
  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'value';
    return res.status(409).json({ error: `A record with this ${field} already exists` });
  }
  req.log?.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}
