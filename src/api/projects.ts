import { createServerFn } from "@tanstack/react-start";
import {
  listProjects,
  getProject,
  saveProject,
  deleteProject,
  getDatabaseType,
  type ProjectRecord,
} from "@/db";

export const getDbInfoFn = createServerFn({ method: "GET" }).handler(async () => {
  return {
    dbType: getDatabaseType(),
  };
});

export const listProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
  return await listProjects();
});

export const getProjectFn = createServerFn({ method: "GET" })
  .validator((d: string) => d)
  .handler(async ({ data: id }) => {
    return await getProject(id);
  });

export const saveProjectFn = createServerFn({ method: "POST" })
  .validator((d: Partial<ProjectRecord> & { id: string }) => d)
  .handler(async ({ data }) => {
    return await saveProject(data);
  });

export const deleteProjectFn = createServerFn({ method: "POST" })
  .validator((d: string) => d)
  .handler(async ({ data: id }) => {
    return await deleteProject(id);
  });
