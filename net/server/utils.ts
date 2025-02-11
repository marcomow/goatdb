import type { ServerServices } from './server.ts';

export function getRequestPath<T extends string = string>(req: Request): T {
  return new URL(req.url).pathname.toLowerCase() as T;
}

/**
 * Returns the base URL for the current application.
 *
 * @param services The services of the current server instance.
 * @returns A fully qualified base URL.
 */
export function getBaseURL(services: ServerServices): string {
  if (services.buildInfo.debugBuild) {
    return 'http://localhost:8080';
  }
  return services.resolveDomain(services.db.orgId);
}
