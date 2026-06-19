/**
 * Express error handler middleware.
 *
 * @param {any} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function errorHandler(err, req, res, next) {
  // eslint-disable-next-line no-unused-vars
  const status = err?.statusCode || err?.status || 500;
  const message = err?.message || 'Internal Server Error';

  res.status(status).json({
    message,
  });
}


