export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

function toQuery(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function request(method, url, { body, params } = {}) {
  let res;
  try {
    res = await fetch(`/api${url}${toQuery(params)}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your network connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.details);
  }
  return data;
}

export const api = {
  get: (url, params) => request('GET', url, { params }),
  post: (url, body = {}) => request('POST', url, { body }),
  put: (url, body) => request('PUT', url, { body }),
  patch: (url, body) => request('PATCH', url, { body }),
  del: (url) => request('DELETE', url),
};
