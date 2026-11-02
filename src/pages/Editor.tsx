import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { EditRail } from '../components/EditRail';
import { EditorToolbar } from '../components/EditorToolbar';
import { ExportPanel } from '../components/ExportPanel';
import { Icon } from '../components/Icon';
import { PhotoStage } from '../components/PhotoStage';
import { PresetBrowser } from '../components/PresetBrowser';
import { ProjectsPanel } from '../components/ProjectsPanel';
import { IDENTITY } from '../lib/image/adjustments';
import { fingerprint, type Project } from '../lib/projectStore';
import { presetAdjustments, type Preset } from '../lib/preset/schema';
import { usePhotoLoader } from '../lib/usePhotoLoader';
import { useAdjustments } from '../lib/useAdjustments';

type PanelKind = 'export' | 'projects' | null;

type Notice = {
  tone: 'ok' | 'waiting';
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
};

/** Typing in a field is the field's own business; a range is not. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['range', 'button', 'checkbox', 'radio', 'submit', 'file'].includes(target.type);
  }
  return false;
}

export function Editor() {
  const { photo, status, error, load, dismissError } = usePhotoLoader();
  const edits = useAdjustments(photo?.url);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [pending, setPending] = useState<Project | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pane, setPane] = useState<'looks' | 'edit'>('looks');
  const depth = useRef(0);
  const appliedPending = useRef<string | null>(null);
  const warnedFor = useRef<string | null>(null);

  /* A look replaces the recipe rather than adding to it: every knob it does not
     mention comes back to identity, and the intensity starts at full. */
  const applyLook = useCallback(
    (preset: Preset) => edits.applyPreset(presetAdjustments(preset, IDENTITY), preset.id),
    [edits.applyPreset],
  );

  const cancelPending = useCallback(() => {
    setPending(null);
    setNotice(null);
  }, []);

  const restore = useCallback(
    (project: Project) => {
      setPanel(null);
      if (photo && fingerprint(photo) === project.id) {
        edits.applyState(project.editing);
        setPending(null);
        setNotice({
          tone: 'ok',
          title: `Restored “${project.name}”`,
          detail: 'The saved recipe is on the photograph. Undo steps back to where it was before.',
        });
        return;
      }
      setPending(project);
      setNotice({
        tone: 'waiting',
        title: `“${project.name}” is waiting for its photograph`,
        detail: `Saved with ${project.photo.name} · ${project.photo.width} × ${project.photo.height} px. Upload that file and the recipe is applied as soon as it arrives. The image itself was never stored.`,
        actionLabel: 'Cancel restore',
        onAction: cancelPending,
      });
    },
    [photo, edits.applyState, cancelPending],
  );

  /* A restored project meets its photograph when the matching file lands. */
  useEffect(() => {
    if (!pending || !photo) return;
    if (fingerprint(photo) !== pending.id) return;
    if (appliedPending.current === photo.url) return;
    appliedPending.current = photo.url;
    edits.applyState(pending.editing);
    setPending(null);
    setNotice({
      tone: 'ok',
      title: `Restored “${pending.name}”`,
      detail: 'The matching photograph arrived, so the saved recipe was applied to it.',
    });
  }, [photo, pending, edits.applyState]);

  /* The wrong file is not quietly pressed on. Say which one is expected. */
  useEffect(() => {
    if (!pending || !photo) return;
    if (fingerprint(photo) === pending.id) return;
    if (warnedFor.current === photo.url) return;
    warnedFor.current = photo.url;
    setNotice({
      tone: 'waiting',
      title: `That file is not the one “${pending.name}” was saved with`,
      detail: `The project expects ${pending.photo.name} · ${pending.photo.width} × ${pending.photo.height} px. The photograph on the stage has not been touched, and the recipe is still waiting.`,
      actionLabel: 'Cancel restore',
      onAction: cancelPending,
    });
  }, [photo, pending, cancelPending]);

  /* A success is a fact worth reading once, not a permanent overlay. */
  useEffect(() => {
    if (!notice || notice.tone !== 'ok') return;
    const id = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (isTextEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
      if (wantsRedo) {
        if (!edits.canRedo) return;
        event.preventDefault();
        edits.redo();
        return;
      }
      if (!edits.canUndo) return;
      event.preventDefault();
      edits.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edits.canUndo, edits.canRedo, edits.undo, edits.redo]);

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types?.includes('Files') ?? false;

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void load(file);
    },
    [load],
  );

  return (
    <div
      className="ws surface-dark"
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <a className="skip-link skip-link--dark" href="#main">
        Skip to the photograph
      </a>

      <EditorToolbar
        photo={photo}
        busy={status === 'loading'}
        onFile={(f) => void load(f)}
        canUndo={edits.canUndo}
        canRedo={edits.canRedo}
        steps={edits.steps}
        onUndo={edits.undo}
        onRedo={edits.redo}
        onExport={() => setPanel('export')}
        onProjects={() => setPanel('projects')}
      />

      <div className="ws__body" data-pane={pane}>
        <main className="ws__stage" id="main" tabIndex={-1}>
          <h1 className="sr-only">Edit a photograph</h1>
          <PhotoStage
            photo={photo}
            values={edits.values}
            status={status}
            error={error}
            onFile={(f) => void load(f)}
            onDismissError={dismissError}
          />
        </main>

        {/* Only small screens show this: there, the photograph keeps the top of
            the screen and one panel at a time sits beneath it. */}
        <div className="ws__switch" role="group" aria-label="Workspace panels">
          <button
            type="button"
            className={['caps', 'mode__tab', pane === 'looks' && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={pane === 'looks'}
            onClick={() => setPane('looks')}
          >
            Looks
          </button>
          <button
            type="button"
            className={['caps', 'mode__tab', pane === 'edit' && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={pane === 'edit'}
            onClick={() => setPane('edit')}
          >
            Adjust
          </button>
        </div>

        <div className="ws__presets">
          <PresetBrowser
            photo={photo}
            selected={edits.activePreset}
            modified={edits.modified}
            intensity={edits.intensity}
            onApply={applyLook}
            onClear={edits.reset}
            onIntensity={edits.setIntensity}
          />
        </div>

        <div className="ws__quick">
          <EditRail
            photo={photo}
            values={edits.values}
            dirty={edits.dirty}
            hasLook={edits.activePreset !== null}
            onChange={edits.set}
            onResetKnob={edits.resetKnob}
            onReset={edits.reset}
          />
        </div>
      </div>

      {panel === 'export' && photo && (
        <ExportPanel
          key={photo.url}
          photo={photo}
          values={edits.values}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'projects' && (
        <ProjectsPanel
          photo={photo}
          editing={edits.snapshot}
          activePreset={edits.activePreset}
          pendingId={pending?.id ?? null}
          onRestore={restore}
          onClose={() => setPanel(null)}
        />
      )}

      {notice && (
        <div className={`toast toast--${notice.tone}`} role="status">
          <div className="toast__body">
            <p className="toast__title">{notice.title}</p>
            {notice.detail && <p className="toast__detail">{notice.detail}</p>}
            {notice.actionLabel && notice.onAction && (
              <button type="button" className="toast__action caps" onClick={notice.onAction}>
                {notice.actionLabel}
              </button>
            )}
          </div>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* pointer-events: none — the drop always lands on the workspace. */}
      <div className={['veil', dragging && 'is-active'].filter(Boolean).join(' ')} aria-hidden="true">
        <div className="veil__inner">
          <Icon name="upload" size={30} />
          <p className="display display--m">Release to load</p>
          <p className="meta meta--micro">
            JPEG, PNG or WebP
            {photo && ' · replaces the photograph on the stage'}
          </p>
        </div>
      </div>
    </div>
  );
}
