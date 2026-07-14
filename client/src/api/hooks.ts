import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Scan, ScanEvent, CreateScanRequest, Settings } from "@repo-radar/shared";
import { api } from "./client.js";

export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: api.health });
export const useScans = () =>
  useQuery({ queryKey: ["scans"], queryFn: api.listScans, refetchInterval: 4000 });
export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings });

export const useScan = (id: string | undefined) =>
  useQuery({ queryKey: ["scan", id], queryFn: () => api.getScan(id!), enabled: !!id });
export const useFindings = (id: string | undefined) =>
  useQuery({ queryKey: ["findings", id], queryFn: () => api.findings(id!), enabled: !!id });
export const useRuns = (id: string | undefined) =>
  useQuery({ queryKey: ["runs", id], queryFn: () => api.runs(id!), enabled: !!id });

export function useCreateScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScanRequest) => api.createScan(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scans"] }),
  });
}

export function useDeleteScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteScan(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scans"] }),
  });
}

export function useCancelScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelScan(id),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ["scans"] });
      void qc.invalidateQueries({ queryKey: ["scan", id] });
    },
  });
}

export function useFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ findingId, vote }: { findingId: string; scanId: string; vote: "up" | "down" | null }) =>
      api.setFeedback(findingId, vote),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["findings", vars.scanId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export const useNightlyStatus = () =>
  useQuery({ queryKey: ["nightly"], queryFn: api.nightlyStatus, refetchInterval: 10_000 });

export function useNightlyRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.nightlyRun(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["nightly"] });
      void qc.invalidateQueries({ queryKey: ["scans"] });
    },
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Settings>) => api.updateSettings(body),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
}

/**
 * Subscribe to a scan's SSE stream. On each event, refetch the scan (and
 * findings when it completes) so the UI updates live during a run.
 */
export function useScanStream(scanId: string | undefined): ScanEvent[] {
  const qc = useQueryClient();
  const [events, setEvents] = useState<ScanEvent[]>([]);

  useEffect(() => {
    if (!scanId) return;
    setEvents([]);
    const es = new EventSource(`/api/scans/${scanId}/events`);

    es.addEventListener("snapshot", (e) => {
      try {
        const scan = JSON.parse((e as MessageEvent).data) as Scan;
        qc.setQueryData(["scan", scanId], scan);
      } catch {
        /* ignore */
      }
    });

    es.onmessage = (e) => {
      let evt: ScanEvent;
      try {
        evt = JSON.parse(e.data) as ScanEvent;
      } catch {
        return;
      }
      setEvents((prev) => [...prev, evt]);
      qc.invalidateQueries({ queryKey: ["scan", scanId] });
      if (evt.type === "scan:done" || evt.type === "scan:failed") {
        qc.invalidateQueries({ queryKey: ["findings", scanId] });
        qc.invalidateQueries({ queryKey: ["runs", scanId] });
        qc.invalidateQueries({ queryKey: ["scans"] });
        es.close();
      }
    };

    es.onerror = () => {
      // Browser auto-reconnects; nothing to do.
    };

    return () => es.close();
  }, [scanId, qc]);

  return events;
}
