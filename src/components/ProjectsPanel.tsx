import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Progress } from './Progress';
import { formatBytes, type Photo } from '../lib/photoStore';
import type { EditingSnapshot } from '../lib/useAdjustments';
import {
  ProjectError,
  defaultProjectName,
  deleteProject,
  fingerprint,
  listProjects,
  newProject,
  saveProject,
  type Project,
} from '../lib/projectStore';
import { loadLibrary } from '../lib/preset/library';

type ProjectsPanelProps = {
  photo: Photo | null;
  editing: EditingSnapshot;
  activePreset: string | null;
  pendingId: string | null;
  onRestore: (project: Project) => void;
  onClose: () => void;
};

/** The id is the reference; the name is only a label saved for this list. */
async function presetNameFor(id: string | null): Promise<string | null> {
  if (!id) return null;
  try {
    const library = await loadLibrary();
    return library.presets.find((preset) => preset.id === id)?.name ?? null;
  } catch {
    return null;
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function describeRecipe(project: Project): string {
  const { chosen, intensity, offsets } = project.editing;
  const turns = Object.values(offsets).filter((value) => value !== 0).length;
  if (!chosen && turns === 0) return 'Unedited';
  if (!chosen) return `${turns} hand ${plural(turns, 'turn', 'turns')}`;
  const look = project.presetName ?? 'Saved look';
  const strength = intensity === 100 ? '' : ` at ${Math.round(intensity)}%`;
  const extra = turns > 0 ? `, ${turns} hand ${plural(turns, 'turn', 'turns')}` : '';
  return `${look}${strength}${extra}`;
}

function when(savedAt: number): string {
  if (!savedAt) return 'date unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    savedAt,
  );
}

/**
 * The project drawer.
 *
 * It is explicit about what is and is not kept: the recipe and the facts about
 * the file go into IndexedDB, the photograph does not. A restored project for a
 * file that is not on the stage waits for that file rather than being pressed
 * onto a different photograph.
 */
export function ProjectsPanel({
  photo,
  editing,
  activePreset,
  pendingId,
  onRestore,
  onClose,
}: ProjectsPanelProps) {
  const [records, setRecords] = useState<Project[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const prefillFor = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setStatus('loading');
    try {
      setRecords(await listProjects());
      setStatus('ready');
    } catch (caught) {
      setError(caught instanceof ProjectError ? caught.message : 'Saved edits could not be read.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const currentId = useMemo(() => (photo ? fingerprint(photo) : null), [photo]);
  const own = useMemo(
    () => (currentId ? records.find((record) => record.id === currentId) ?? null : null),
    [currentId, records],
  );

  /* One prefill per photograph: a later reload must not overwrite a name the
     user is in the middle of typing. */
  useEffect(() => {
    if (!photo || status !== 'ready') return;
    const id = fingerprint(photo);
    if (prefillFor.current === id) return;
    prefillFor.current = id;
    const saved = records.find((record) => record.id === id);
    setName(saved?.name ?? defaultProjectName(photo));
  }, [photo, records, status]);

  async function save() {
    if (!photo || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const label = await presetNameFor(activePreset);
      const record = newProject(photo, editing, name, label);
      await saveProject(record);
      setNotice(
        record.editing.chosen
          ? `Saved “${record.name}”${label ? ` with ${label}` : ''}. The photograph was not copied.`
          : `Saved “${record.name}”. The photograph was not copied.`,
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof ProjectError ? caught.message : 'The edit could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(project: Project) {
    if (confirmId !== project.id) {
      setConfirmId(project.id);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await deleteProject(project.id);
      setConfirmId(null);
      setNotice(`Deleted “${project.name}”.`);
      await reload();
    } catch (caught) {
      setError(caught instanceof ProjectError ? caught.message : 'The project could not be deleted.');
    }
  }

  return (
    <Panel
      eyebrow="On this device"
      title="Projects"
      wide
      onClose={onClose}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="sheet__lede body-muted">
        A project keeps the recipe — the look, its intensity and your hand turns — plus the name,
        pixel size and file name it belongs to. The photograph itself is never copied into the
        browser; it stays in your folder.
      </p>

      {photo ? (
        <div className="projects__save">
          <label className="field">
            <span className="meta meta--micro">Project name</span>
            <input
              className="input"
              type="text"
              value={name}
              maxLength={120}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              placeholder={defaultProjectName(photo)}
            />
          </label>
          <div className="projects__save-side">
            <span className="meta meta--micro projects__save-facts">
              {photo.name} · {photo.width} × {photo.height} px · {formatBytes(photo.bytes)}
            </span>
            <Button
              variant="primary"
              size="sm"
              iconLeft="check"
              disabled={saving || status !== 'ready'}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : own ? 'Update saved edit' : 'Save this edit'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="sheet__note">
          Load a photograph to save its edit. You can still restore a saved project below — it will
          wait for the matching file.
        </p>
      )}

      <div className="projects__head">
        <h3 className="caps projects__title">Saved on this device</h3>
        {status === 'ready' && (
          <span className="meta meta--micro">{records.length} saved</span>
        )}
      </div>

      {status === 'loading' && (
        <div className="sheet__state" role="status">
          <Progress label="Reading saved projects" />
          <span className="meta meta--micro">Reading saved projects…</span>
        </div>
      )}

      {status === 'error' && (
        <div className="sheet__error" role="alert">
          <Icon name="close" size={16} />
          <p className="meta meta--micro">{error ?? 'Saved projects are unavailable.'}</p>
        </div>
      )}

      {status === 'ready' && records.length === 0 && (
        <p className="projects__empty body-muted">
          Nothing saved yet. Save an edit here and it will still be listed after you close the tab —
          though the photograph will have to be uploaded again before it can be applied.
        </p>
      )}

      {status === 'ready' && records.length > 0 && (
        <ul className="projects__list">
          {records.map((record) => {
            const here = record.id === currentId;
            const waiting = record.id === pendingId;
            return (
              <li className={['project', here && 'is-here'].filter(Boolean).join(' ')} key={record.id}>
                <div className="project__top">
                  <span className="project__name">{record.name}</span>
                  <span className="meta meta--micro project__when">{when(record.savedAt)}</span>
                </div>
                <span className="meta meta--micro project__look">{describeRecipe(record)}</span>
                <span className="meta meta--micro project__photo">
                  {record.photo.name} · {record.photo.width} × {record.photo.height} px
                  {record.photo.bytes > 0 ? ` · ${formatBytes(record.photo.bytes)}` : ''}
                </span>
                <span className="project__tags">
                  {here && <span className="tag">On the stage</span>}
                  {waiting && <span className="tag tag--pending">Waiting for its photograph</span>}
                  {!here && !waiting && (
                    <span className="tag tag--pending">Needs the original file</span>
                  )}
                </span>
                <div className="project__actions">
                  <Button variant="secondary" size="sm" iconLeft="undo" onClick={() => onRestore(record)}>
                    Restore
                  </Button>
                  {confirmId === record.id ? (
                    <>
                      <Button variant="signal" size="sm" onClick={() => void remove(record)}>
                        Delete it
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => void remove(record)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notice && (
        <p className="sheet__note" role="status">
          {notice}
        </p>
      )}
      {error && status !== 'error' && (
        <div className="sheet__error" role="alert">
          <Icon name="close" size={16} />
          <p className="meta meta--micro">{error}</p>
        </div>
      )}

      <p className="sheet__note">
        Restoring a project saved with a different file will not touch the photograph on the stage.
        Latent remembers that file by name, byte size and pixel size, and applies the recipe as soon
        as you upload it again.
      </p>
    </Panel>
  );
}
