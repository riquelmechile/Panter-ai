/** Declarative requests only: they cannot switch the connected host's model. */
export type Profile = 'chatgpt' | 'host-native';

export interface HostRequest {
  status: 'REQUESTED';
  profile: Profile;
  model: string;
  reasoningEffort: string;
  reasoningFallback: string | null;
  rootProcessing: string;
  worker: {
    model: string;
    reasoningEffort: string;
    preferredProcessing: string;
    fallbackProcessing: string;
  };
  requestedWorkers: string;
  plannerCeiling: number;
  actualWorkers: 'UNKNOWN_UNTIL_HOST_REPORTS';
  inferenceApiCalls: 0;
  serverModelWorkers: 0;
}

export function hostRequest(profile: Profile = 'chatgpt'): HostRequest {
  const chatgpt = profile === 'chatgpt';
  return {
    status: 'REQUESTED',
    profile,
    model: chatgpt ? 'gpt-6-astra' : 'host-selected',
    reasoningEffort: chatgpt ? 'max' : 'host-maximum',
    reasoningFallback: chatgpt ? 'xhigh' : null,
    rootProcessing: 'standard',
    worker: {
      model: chatgpt ? 'gpt-6-astra' : 'inherit-host-model',
      reasoningEffort: chatgpt ? 'max' : 'inherit-host-effort',
      preferredProcessing: 'fast-if-supported',
      fallbackProcessing: 'standard-preserve-reasoning',
    },
    requestedWorkers: 'maximum-host-available-for-independent-work',
    plannerCeiling: 32,
    actualWorkers: 'UNKNOWN_UNTIL_HOST_REPORTS',
    inferenceApiCalls: 0,
    serverModelWorkers: 0,
  };
}

export interface HostEvidence {
  model?: string;
  reasoningEffort?: string;
  workerCount?: number;
  processing?: string;
  source: 'host-reported';
}

/** Caller-reported is not independently attested. */
export function assessEvidence(request: HostRequest, report?: HostEvidence) {
  if (!report) return { evidence: 'REQUESTED_ONLY', observed: false, matches: null } as const;
  const modelMatches = request.profile !== 'chatgpt' || report.model === request.model;
  const effortMatches = request.profile !== 'chatgpt' || report.reasoningEffort === 'max' || report.reasoningEffort === 'xhigh';
  const capMatches = report.workerCount === undefined ||
    (Number.isInteger(report.workerCount) && report.workerCount >= 0 && report.workerCount <= request.plannerCeiling);
  return { evidence: 'HOST_REPORTED_UNVERIFIED', observed: false, matches: modelMatches && effortMatches && capMatches } as const;
}
