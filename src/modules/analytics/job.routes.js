import { getJobStatus } from './job.controller.js';

export default async function jobRoutes(fastify, options) {
  fastify.get('/jobs/:id', getJobStatus);
}
