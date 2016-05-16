// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import * as CodeMirror
  from 'codemirror';

import 'codemirror/mode/meta';

import {
  INotebookSession
} from 'jupyter-js-services';

import {
  copy, shallowEquals
} from 'jupyter-js-utils';

import {
  IDisposable
} from 'phosphor-disposable';

import {
  IObservableList, ObservableList, ListChangeType, IListChangedArgs
} from 'phosphor-observablelist';

import {
  IChangedArgs, Property
} from 'phosphor-properties';

import {
  ISignal, Signal, clearSignalData
} from 'phosphor-signaling';

import {
  EditorModel, IEditorModel, IEditorOptions, EdgeLocation
} from '../editor/model';

import {
  InputAreaModel, IInputAreaModel
} from '../input-area/model';

import {
  OutputAreaModel, IOutputAreaModel
} from '../output-area/model';


import {
  IDocumentModel
} from 'jupyter-js-ui/lib/docmanager';

import {
  ICellModel,
  ICodeCellModel, CodeCellModel,
  IMarkdownCellModel, MarkdownCellModel,
  IRawCellModel, isCodeCellModel, isMarkdownCellModel,
  RawCellModel, isRawCellModel, MetadataCursor, IMetadataCursor,
} from '../cells/model';

import {
  OutputType, IKernelspecMetadata, ILanguageInfoMetadata
} from './nbformat';


/**
 * The default notebook kernelspec metadata.
 */
const DEFAULT_KERNELSPEC = {
  name: 'unknown',
  display_name: 'No Kernel!'
}

/**
 * The default notebook languageinfo metadata.
 */
const DEFAULT_LANG_INFO = {
  name: 'unknown'
}


/**
 * The model object for a notebook widget.
 */
export
interface INotebookModel extends IDocumentModel {
  /**
   * A signal emitted when state of the notebook changes.
   */
  contentChanged: ISignal<INotebookModel, IChangedArgs<any>>;

  /**
   * A signal emitted when a user metadata state changes.
   */
  metadataChanged: ISignal<INotebookModel, string>;

  /**
   * Serialize the model.  It should return a JSON object or a string.
   */
  serialize(): any;

  /**
   * Deserialize the model from a string or a JSON object.
   *
   * #### Notes
   * Should emit a [contentChanged] signal.
   */
  deserialize(value: any): void;

  /**
   * The default kernel name of the document.
   *
   * #### Notes
   * This is a read-only property.
   */
  defaultKernelName: string;

  /**
   * The default kernel language of the document.
   *
   * #### Notes
   * This is a read-only property.
   */
  defaultKernelLanguage: string;


  // Metadata information

  /**
   * The kernelspec metadata associated with the notebook.
   */
  kernelspec: IKernelspecMetadata;

  /**
   * The language info metadata associated with the notebook.
   */
  languageInfo: ILanguageInfoMetadata;

  /**
   * The original nbformat associated with the notebook.
   */
  origNbformat: number;


  // Content

  /**
   * The list of cells in the notebook.
   *
   * #### Notes
   * This is a read-only property.
   */
  cells: IObservableList<ICellModel>;

  // Convenience functions for creating submodels.  

  /**
   * A factory for creating a new code cell.
   *
   * @param source - The cell to use for the original source data.
   *
   * @returns A new code cell. If a source cell is provided, the
   *   new cell will be intialized with the data from the source.
   *
   * #### Notes
   * If the source argument does not give an input mimetype, the code cell
   * defaults to the notebook [[defaultMimetype]].
   */
  createCodeCell(source?: ICellModel): ICodeCellModel;

  /**
   * A factory for creating a new Markdown cell.
   *
   * @param source - The cell to use for the original source data.
   *
   * @returns A new markdown cell. If a source cell is provided, the
   *   new cell will be intialized with the data from the source.
   */
  createMarkdownCell(source?: ICellModel): IMarkdownCellModel;

  /**
   * A factory for creating a new raw cell.
   *
   * @param source - The cell to use for the original source data.
   *
   * @returns A new raw cell. If a source cell is provided, the
   *   new cell will be intialized with the data from the source.
   */
  createRawCell(source?: ICellModel): IRawCellModel;

  /**
   * Get a metadata cursor for the notebook.
   *
   * #### Notes
   * Metadata associated with the nbformat spec are set directly
   * on the model.  This method is used to interact with a namespaced
   * set of metadata on the notebook.
   */
  getMetadata(namespace: string): IMetadataCursor;

  /**
   * List the metadata namespace keys for the notebook.
   *
   * #### Notes
   * Metadata associated with the nbformat are not included.
   */
   listMetadata(): string[];  
}


/**
 * An implementation of a notebook model.
 */
export
class NotebookModel implements INotebookModel {  

  /**
   * Create an output area model.
   */
  static createOutputArea(): IOutputAreaModel {
    return new OutputAreaModel();
  }

  /**
   * Construct a new notebook model.
   */
  constructor() {
    this._cells = new ObservableList<ICellModel>();
    this._cells.changed.connect(this.onCellsChanged, this);
  }

  /**
   * A signal emitted when the state of the model changes.
   */
  get contentChanged(): ISignal<INotebookModel, IChangedArgs<any>> {
    return NotebookModelPrivate.stateChangedSignal.bind(this);
  }

  /**
   * A signal emitted when a user metadata state changes.
   *
   * #### Notes
   * The signal argument is the namespace of the metadata that changed.
   */
  get metadataChanged(): ISignal<INotebookModel, string> {
    return NotebookModelPrivate.metadataChangedSignal.bind(this);
  }
  
  
  /**
   * The default kernel name of the document.
   *
   * #### Notes
   * This is a read-only property.
   */
  get defaultKernelName(): string {
    return '';
  }

  /**
   * The default kernel language of the document.
   *
   * #### Notes
   * This is a read-only property.
   */
  get defaultKernelLanguage(): string {
    return this._defaultLang;
  }
    
    
  /**
   * The kernelspec metadata for the notebook.
   */
  get kernelspec(): IKernelspecMetadata {
    return JSON.parse(this._kernelspec);
  }
  set kernelspec(newValue: IKernelspecMetadata) {
    let oldValue = JSON.parse(this._kernelspec);
    if (shallowEquals(oldValue, newValue)) {
      return;
    }
    this._kernelspec = JSON.stringify(newValue);
    let name = 'kernelspec';
    this.contentChanged.emit({ name, oldValue, newValue });
  }

  /**
   * The language info metadata for the notebook.
   */
  get languageInfo(): ILanguageInfoMetadata {
    return JSON.parse(this._langInfo);
  }
  set languageInfo(newValue: ILanguageInfoMetadata) {
    let oldValue = JSON.parse(this._langInfo);
    if (shallowEquals(oldValue, newValue)) {
      return;
    }
    this._langInfo = JSON.stringify(newValue);
    let name = 'languageInfo';
    this.contentChanged.emit({ name, oldValue, newValue });
  }

  /**
   * The original nbformat version for the notebook.
   */
  get origNbformat(): number {
    return this._origNbformat;
  }
  set origNbformat(newValue: number) {
    if (newValue === this._origNbformat) {
      return;
    }
    let oldValue = this._origNbformat;
    this._origNbformat = newValue;
    let name = 'origNbformat';
    this.contentChanged.emit({ name, oldValue, newValue });
  }


  /**
   * Serialize the model.
   */
  serialize(): any {
    return {};
  }

  /**
   * Deserialize the model from a string.
   */
  deserialize(value: any): void {
    // TODO: deserialize
    this.contentChanged.emit(value);
  }


  /**
   * Get the observable list of notebook cells.
   *
   * #### Notes
   * This is a read-only property.
   */
  get cells(): IObservableList<ICellModel> {
    return this._cells;
  }

  /**
   * Handle a change in the cells list.
   */
  protected onCellsChanged(list: ObservableList<ICellModel>, change: IListChangedArgs<ICellModel>): void {
    let cell: ICellModel;
    switch (change.type) {
    case ListChangeType.Remove:
      (change.oldValue as ICellModel).dispose();
      break;
    case ListChangeType.Replace:
      let oldValues = change.oldValue as ICellModel[];
      for (cell of oldValues) {
        cell.dispose();
      }
      break;
    }
  }


  /**
   * Create a code cell model.
   */
  createCodeCell(source?: ICellModel): ICodeCellModel {
    let constructor = this.constructor as typeof NotebookModel;
    let output = constructor.createOutputArea();
    let cell = new CodeCellModel(output);
    cell.trusted = true;
    if (source) {
      cell.trusted = source.trusted;
      cell.source = source.source;
      cell.tags = source.tags;
      if (isCodeCellModel(source)) {
        cell.collapsed = source.collapsed;
        cell.scrolled = source.scrolled;
        for (let i = 0; i < source.output.outputs.length; i++) {
          let sourceOutput = source.output.outputs.get(i);
          cell.output.outputs.add(sourceOutput);
        }
      }
    }
    return cell;
  }

  /**
   * Create a markdown cell model.
   */
  createMarkdownCell(source?: ICellModel): IMarkdownCellModel {
    let constructor = this.constructor as typeof NotebookModel;
    let cell = new MarkdownCellModel();
    cell.trusted = true;
    if (source) {
      cell.trusted = source.trusted;
      cell.source = source.source;
      cell.tags = source.tags;
    }
    return cell;
  }

  /**
   * Create a raw cell model.
   */
  createRawCell(source?: ICellModel): IRawCellModel {
    let constructor = this.constructor as typeof NotebookModel;
    let cell = new RawCellModel();
    cell.trusted = true;
    if (source) {
      cell.trusted = source.trusted;
      cell.source = source.source;
      cell.tags = source.tags;
      if (isRawCellModel(source)) {
        cell.format = (source as IRawCellModel).format;
      }
    }
    return cell;
  }


  /**
   * Get a metadata cursor for the notebook.
   *
   * #### Notes
   * Metadata associated with the nbformat spec are set directly
   * on the model.  This method is used to interact with a namespaced
   * set of metadata on the notebook.
   */
  getMetadata(name: string): IMetadataCursor {
    let invalid = ['kernelspec', 'languageInfo', 'origNbformat'];
    if (invalid.indexOf(name) !== -1) {
      let key = invalid[invalid.indexOf(name)];
      throw Error(`Use model attribute for ${key} directly`);
    }
    return new MetadataCursor(
      name,
      this._metadata,
      this._cursorCallback.bind(this)
    );
  }

  /**
   * List the metadata namespace keys for the notebook.
   *
   * #### Notes
   * Metadata associated with the nbformat are not included.
   */
  listMetadata(): string[] {
    return Object.keys(this._metadata);
  }
  
  /**
   * The singleton callback for cursor change events.
   */
  private _cursorCallback(name: string): void {
    this.metadataChanged.emit(name);
  }


  private _defaultLang = '';
  private _metadata: { [key: string]: string } = Object.create(null);
  private _cells: IObservableList<ICellModel> = null;
  private _kernelspec = JSON.stringify(DEFAULT_KERNELSPEC);
  private _langInfo = JSON.stringify(DEFAULT_LANG_INFO);
  private _origNbformat: number = null;

}


/**
 * A private namespace for notebook model data.
 */
namespace NotebookModelPrivate {
  /**
   * A signal emitted when the state of the model changes.
   */
  export
  const stateChangedSignal = new Signal<INotebookModel, IChangedArgs<any>>();

  /**
   * A signal emitted when a user metadata state changes.
   */
  export
  const metadataChangedSignal = new Signal<INotebookModel, string>();
}
