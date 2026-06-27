export type ValidatorId = string;

export type Message = {
  from: ValidatorId;
  to: ValidatorId;
  round: number;
  payload: any;
};

export type Partition = {
  groups: ValidatorId[][]; // messages between groups are dropped
  durationRounds?: number;
};

export type Delay = {
  ms: number; // base delay in ms
  jitter?: number; // added random jitter
  probability?: number; // probability to delay each message
};

export type Equivocation = {
  by: ValidatorId[]; // validators that equivocate
  roundSpan?: number; // rounds over which equivocation occurs
};

export type TimeoutFault = {
  by: ValidatorId[]; // validators that timeout (stop sending)
  durationRounds?: number;
};

export type FaultSpec = {
  partition?: Partition | null;
  delay?: Delay | null;
  equivocation?: Equivocation | null;
  timeout?: TimeoutFault | null;
};

export type SimulationConfig = {
  validators: ValidatorId[];
  maxRounds?: number;
  faultSpec?: FaultSpec;
};
