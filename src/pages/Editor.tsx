import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { AiAssistant } from '../components/AiAssistant';
import { EditRail } from '../components/EditRail';
import { EditorToolbar } from '../components/EditorToolbar';
import { ExportPanel } from '../components/ExportPanel';
import { Icon } from '../components/Icon';
import { PhotoStage } from '../components/PhotoStage';
import { ProposalBar } from '../components/ProposalBar';
import { PresetBrowser } from '../components/PresetBrowser';
import { ProjectsPanel } from '../components/ProjectsPanel';
import { fingerprint, type Project } from '../lib/projectStore';
import { conversationalPreset } from '../lib/ai/nlParser';
import type { Adjustments } from '../lib/image/adjustments';
import { useEditingSession } from '../lib/useEditingSession';

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
  const session = useEditingSession();
  const { photo, status, error, load, dismissError, edits, mode, setMode, applyLook, proposals, undo, redo } = session;
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [pending, setPending] = useState<Project | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pane, setPane] = useState<'looks' | 'edit'>('looks');
  const depth = useRef(0);
  const appliedPending = useRef<string | null>(null);
  const warnedFor = useRef<string | null>(null);

  // Counter for synthetic preset IDs used by the conversational editor.
  const synthCounter = useRef(0);

  /**
   * Preview an adjustment-based proposal from the AI rail.
   *
   * A previewed look *replaces* what the stage draws — that is how Enhance and
   * Style Search work — so the recipe handed to the proposal has to be the whole
   * edit, not only the knobs the sentence named. The panel sends the change
   * resolved against the live values; folding it over the current state is what
   * keeps an applied look and earlier hand turns visible in the preview and
   * alive after the accept.
   *
   * `origin` is what the bar above the stage says the proposal came from. It is
   * a parameter rather than a constant because the reference matcher sends a
   * whole recipe through here too, and calling that "your words" would be false.
   */
  const handlePreviewAdjustments = useCallback(
    (adjustments: Partial<Adjustments>, summary: string, origin = 'Your words') => {
      const next = { ...edits.values, ...adjustments };
      proposals.preview(conversationalPreset(`conv:${++synthCounter.current}`, summary, next), 'rules', origin);
    },
    [proposals, edits.values],
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
        redo();
        return;
      }
      if (!edits.canUndo) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edits.canUndo, edits.canRedo, undo, redo]);

  /* Escape turns a preview down, the same as the Reject button. */
  const rejectProposal = proposals.reject;
  const hasProposal = proposals.proposal !== null;
  useEffect(() => {
    if (!hasProposal) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (isTextEntry(event.target)) return;
      rejectProposal();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [hasProposal, rejectProposal]);

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
        onUndo={undo}
        onRedo={redo}
        onExport={() => setPanel('export')}
        onProjects={() => setPanel('projects')}
        onEnhance={() => {
          session.requestEnhance();
          setPane('looks');
        }}
        previewing={hasProposal}
      />

      <div className="ws__body" data-pane={pane}>
        <main className="ws__stage" id="main" tabIndex={-1}>
          <h1 className="sr-only">Edit a photograph</h1>
          <PhotoStage
            photo={photo}
            values={proposals.stageValues}
            skinGuard={edits.skinGuard}
            crop={edits.crop}
            onCrop={edits.setCrop}
            status={status}
            error={error}
            onFile={(f) => void load(f)}
            onDismissError={dismissError}
          />
          {proposals.proposal && (
            <ProposalBar
              proposal={proposals.proposal}
              onIntensity={proposals.setIntensity}
              onAccept={proposals.accept}
              onReject={proposals.reject}
            />
          )}
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

        {/* Three editing modes — shared session keeps photo and adjustments
            intact when switching. Rendered above the rails on larger screens
            so the mode is always visible. */}
        <div className="ws__modes" role="group" aria-label="Editing mode">
          <button
            type="button"
            className={['caps', 'mode__tab', mode === 'ai' && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={mode === 'ai'}
            onClick={() => { setMode('ai'); setPane('looks'); }}
          >
            AI Edit
          </button>
          <button
            type="button"
            className={['caps', 'mode__tab', mode === 'presets' && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={mode === 'presets'}
            onClick={() => { setMode('presets'); setPane('looks'); }}
          >
            Presets
          </button>
          <button
            type="button"
            className={['caps', 'mode__tab', mode === 'manual' && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={mode === 'manual'}
            onClick={() => { setMode('manual'); setPane('edit'); }}
          >
            Manual Edit
          </button>
        </div>

        {/* Presets panel — visible in Presets and AI modes */}
        {mode !== 'manual' && (
          <div className="ws__presets">
            {mode === 'ai' ? (
              <AiAssistant
                photo={photo}
                onApply={proposals.applyNow}
                onPreview={proposals.preview}
                onPreviewAdjustments={handlePreviewAdjustments}
                onAcceptProposal={proposals.accept}
                onRejectProposal={proposals.reject}
                previewingId={proposals.proposal?.preset.id ?? null}
                isPreviewing={proposals.proposal !== null}
                enhanceRequest={session.enhanceRequest}
                activePresetId={edits.activePreset}
                currentAdjustments={edits.values}
                intensity={edits.intensity}
                onIntensity={edits.setIntensity}
              />
            ) : (
              <PresetBrowser
                photo={photo}
                selected={edits.activePreset}
                modified={edits.modified}
                intensity={edits.intensity}
                onApply={applyLook}
                onClear={edits.reset}
                onIntensity={edits.setIntensity}
              />
            )}
          </div>
        )}

        {/* Manual Edit rail — always mounted so state is preserved across mode switches */}
        <div className={['ws__quick', mode !== 'manual' && 'ws__quick--hidden'].filter(Boolean).join(' ')}>
          <EditRail
            photo={photo}
            values={edits.values}
            dirty={edits.dirty}
            hasLook={edits.activePreset !== null}
            skinGuard={edits.skinGuard}
            onChange={edits.set}
            onResetKnob={edits.resetKnob}
            onSkinGuard={edits.setSkinGuard}
            onReset={edits.reset}
          />
        </div>
      </div>

      {panel === 'export' && photo && (
        <ExportPanel
          key={photo.url}
          photo={photo}
          values={edits.values}
          skinGuard={edits.skinGuard}
          crop={edits.crop}
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
