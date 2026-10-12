export class HttpError extends Error {
  constructor(status, message, code = "error", fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
export const badRequest = (message, fields) => new HttpError(400, message, "bad_request", fields);
export const unauthorized = (message = "Please sign in", code = "unauthenticated") => new HttpError(401, message, code);
export const forbidden = (message = "You do not have permission to do this") => new HttpError(403, message, "forbidden");
export const notFound = (what = "Item") => new HttpError(404, `${what} not found`, "not_found");
export const conflict = (message) => new HttpError(409, message, "conflict");

/** Turn a duplicate-key database error into a friendly 409 */
export async function dupAs(message, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw conflict(message);
    throw err;
  }
}
