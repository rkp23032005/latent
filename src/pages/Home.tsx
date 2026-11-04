import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { btnClass } from '../components/Button';
import { DropZone } from '../components/DropZone';
import { Icon } from '../components/Icon';
import { Plate } from '../components/Plate';
import { UploadButton } from '../components/UploadButton';
import { looks, workflowFrames } from '../data/looks';
import { loadPhotoFromFile } from '../lib/photoStore';

const moves = [
  {
    no: '01',
    title: 'Load',
    body: 'Drop a photograph straight from your phone or camera roll. It is read in this browser tab and never sent anywhere.',
  },
  {
    no: '02',
    title: 'Choose a look',
    body: 'Six categories named after the light the picture was taken in. Pick one. The sliders stay hidden — you are not asked to understand them.',
  },
  {
    no: '03',
    title: 'Export',
    body: 'Save a full-resolution file, cropped and sized for where it is going: a print, a message, or an archive.',
  },
];

export function Home() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(file: File) {
    setBusy(true);
    setError(null);
    try {
      await loadPhotoFromFile(file);
      navigate('/edit');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be opened.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main">
      {/* ---- Nameplate + primary action ------------------------------- */}
      <section className="hero shell">
        <div className="hero__grid">
          <div>
            <p className="caps hero__eyebrow">Photo editor · in your browser</p>

            <h1 className="display display--xl hero__title">
              Develop the <span className="emph">picture</span> you already saw.
            </h1>

            <p className="lede hero__lede">
              Most photographs look better in memory than they do on screen. Latent closes that gap
              in one choice — no timeline, no panels, nothing to learn first.
            </p>

            <div className="hero__actions" id="upload">
              <DropZone busy={busy} onFile={(f) => void start(f)} index="FRAME 01" />
              {error && (
                <p className="meta meta--micro" role="alert" style={{ color: 'var(--signal)' }}>
                  {error}
                </p>
              )}
            </div>

            <div className="hero__foot">
              <Link className="link-rule" to="/#workflow">
                See how it works
              </Link>
              <span className="meta meta--micro">· 3 moves, no account</span>
            </div>
          </div>

          <div className="hero__plates">
            <Plate
              className="hero__plate--back"
              src="/photography/coast-dusk.jpg"
              alt="A coastline at dusk, printed as a loose reference sheet"
              aspectRatio="4 / 3"
            />
            <Plate
              className="hero__plate--front"
              perfs
              src="/photography/hero-camera.jpg"
              alt="A photographer raising a film camera to her eye"
              caption="Reference frame"
              no="0823"
              aspectRatio="4 / 5"
            />
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- Workflow -------------------------------------------------- */}
      <section className="section shell" id="workflow">
        <header className="shead">
          <h2 className="display display--l shead__title">
            Three moves. That is the whole app.
          </h2>
          <p className="lede">
            The work of editing software is deciding what to move. Latent takes that decision away
            and leaves you with the only one worth making.
          </p>
        </header>

        <div className="workflow">
          <ol className="moves">
            {moves.map((move) => (
              <li className="moves__item" key={move.no}>
                <span className="moves__no">{move.no}</span>
                <h3 className="title">{move.title}</h3>
                <p className="body-muted" style={{ maxWidth: '52ch' }}>
                  {move.body}
                </p>
              </li>
            ))}
          </ol>

          <ul className="strip" aria-hidden="true">
            {workflowFrames.map((frame, i) => (
              <li key={frame.image}>
                <Plate
                  src={frame.image}
                  alt=""
                  aspectRatio="4 / 3"
                  no={`0${i + 1}`}
                  caption={frame.label}
                />
              </li>
            ))}
          </ul>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- Looks ----------------------------------------------------- */}
      <section className="section shell" id="looks">
        <header className="shead">
          <h2 className="display display--l shead__title">
            Six looks, named after <span className="emph">light</span>.
          </h2>
          <p className="lede">
            A preview of the categories you will choose between. Each is a starting point tuned for
            one kind of photograph, not a colour wash laid over everything.
          </p>
        </header>

        <div className="sheet">
          {looks.map((look) => (
            <article className="sheet__cell" key={look.no}>
              <span className="meta meta--micro sheet__no">{look.no}</span>
              <img
                className="sheet__thumb"
                src={look.image}
                alt={`Sample photograph for the ${look.name} category`}
                loading="lazy"
              />
              <div className="look">
                <h3 className="look__name">
                  <span className="look__glyph">
                    <Icon name={look.icon} size={16} />
                  </span>
                  {look.name}
                </h3>
                <p className="meta meta--micro look__blurb">{look.blurb}</p>
              </div>
            </article>
          ))}
        </div>

        <p className="meta meta--micro looks__note">
          A look is a set of knob values, and pressing one onto a photograph is live. The pictures
          above are the app’s own sample photographs, chosen for the category they sit in — they are
          not preset output. In the editor every card is painted by the engine, on your file once you
          have loaded one.
        </p>
      </section>

      {/* ---- Closing band ---------------------------------------------- */}
      <section className="band surface-dark">
        <div className="shell band__grid">
          <div>
            <h2 className="display display--l">Start with the photograph you already have.</h2>
            <div className="band__actions">
              <UploadButton
                id="band-upload-input"
                label="Upload a photo"
                variant="signal"
                size="lg"
              />
              <Link className={btnClass('secondary', 'lg')} to="/edit">
                Open the editor
              </Link>
            </div>
          </div>

          <ul className="band__aside">
            <li>
              <Icon name="check" size={16} /> Runs in this tab
            </li>
            <li>
              <Icon name="check" size={16} /> No account, no watermark
            </li>
            <li>
              <Icon name="check" size={16} /> Full resolution out
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
