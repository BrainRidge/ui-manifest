import type { DomNode } from './dom.js';

export type PropertyBindingKind = 'decorator' | 'signal';

/** An Angular @Input()/@Output() or input()/output() signal. */
export interface PropertyBinding {
  name: string;
  type?: string;
  required?: boolean;
  kind: PropertyBindingKind;
  alias?: string;
}

export type PropSource = 'ts-type' | 'prop-types' | 'unknown';

/** A React component prop. */
export interface PropDefinition {
  name: string;
  type?: string;
  required: boolean;
  source: PropSource;
  isEventHandler?: boolean;
}

export interface ComponentNode {
  className: string;
  /** Repo-relative path to the file the component is defined in. */
  filePath: string;
  /** Angular only. */
  selector?: string;
  /** Angular only. */
  standalone?: boolean;
  templateUrl?: string;
  inlineTemplate?: boolean;
  styleUrls?: string[];
  /** Angular only; always [] for React components. */
  inputs: PropertyBinding[];
  /** Angular only; always [] for React components. */
  outputs: PropertyBinding[];
  /** React only; undefined for Angular components. */
  props?: PropDefinition[];
  /** Present only when the extractor was run with template/JSX parsing enabled. */
  dom?: DomNode[];
}
