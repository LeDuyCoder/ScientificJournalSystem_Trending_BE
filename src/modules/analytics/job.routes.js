import { getJobStatus } from './job.controller.js';

export default async function jobRoutes(fastify) {
  fastify.get('/jobs/:id', getJobStatus);
}
