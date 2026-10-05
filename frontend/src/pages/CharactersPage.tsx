import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { CharacterSummary } from '../api/client';
import { Navbar } from '../components/Navbar';
import { Users, FileJson, Save, Plus, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';

export const CharactersPage: React.FC = () => {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // New character modal/fields
  const [showNewModal, setShowNewModal] = useState<boolean>(false);
  const [newFilename, setNewFilename] = useState<string>('');

  const fetchCharacters = async () => {
    try {
      const res = await api.listCharacters();
      setCharacters(res.characters || []);
      if (!selectedFile && res.characters && res.characters.length > 0) {
        loadCharacter(res.characters[0].filename);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to list characters');
    }
  };

  const loadCharacter = async (filename: string) => {
    setSelectedFile(filename);
    setError(null);
    setSuccess(null);
    setJsonError(null);
    try {
      const res = await api.getCharacter(filename);
      setJsonText(JSON.stringify(res.character, null, 2));
    } catch (err: any) {
      setError(err.message || `Failed to load character ${filename}`);
    }
  };

  useEffect(() => {
    fetchCharacters();
  }, []);

  const handleJsonChange = (val: string) => {
    setJsonText(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(err.message);
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setError(null);
    setSuccess(null);

    let parsedData: any;
    try {
      parsedData = JSON.parse(jsonText);
    } catch (err: any) {
      setJsonError(`Invalid JSON: ${err.message}`);
      return;
    }

    setSaving(true);
    try {
      await api.saveCharacter(selectedFile, parsedData);
      setSuccess(`Character ${selectedFile} saved successfully`);
      fetchCharacters();
    } catch (err: any) {
      setError(err.message || 'Failed to save character');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;
    const confirmed = window.confirm(`Delete persona file "${selectedFile}"?`);
    if (!confirmed) return;

    try {
      await api.deleteCharacter(selectedFile);
      setSelectedFile(null);
      fetchCharacters();
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();
    let fname = newFilename.trim();
    if (!fname.endsWith('.json')) fname += '.json';

    const defaultContent = {
      name: fname.replace(/\.json$/, ''),
      bio: ["Autonomous AI agent for Instagram community engagement."],
      lore: [],
      knowledge: [],
      settings: {
        behavior: {
          enableLikes: true,
          enableComments: true
        }
      }
    };

    try {
      await api.createCharacter(fname, defaultContent);
      setShowNewModal(false);
      setNewFilename('');
      await fetchCharacters();
      loadCharacter(fname);
    } catch (err: any) {
      alert(`Failed to create character: ${err.message}`);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        {/* Top Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={20} color="var(--accent)" />
              AI Personas & Character Profiles
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Fine-tune the tone, bio, lore, and engagement parameters for each AI agent persona.
            </p>
          </div>

          <button
            onClick={() => setShowNewModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              backgroundColor: 'var(--accent)',
              color: 'var(--text-inverse)',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            <Plus size={14} />
            New Persona
          </button>
        </div>

        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'var(--state-error-bg)',
              color: 'var(--state-error)',
              border: '1px solid var(--state-error-border)',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '18px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'var(--state-running-bg)',
              color: 'var(--state-running)',
              border: '1px solid var(--state-running-border)',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '18px',
            }}
          >
            <CheckCircle2 size={16} />
            <span>{success}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '20px' }}>
          {/* Persona List Sidebar */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              height: 'fit-content',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px' }}>
              Installed Personas ({characters.length})
            </div>

            {characters.map((c) => {
              const isSelected = selectedFile === c.filename;
              return (
                <button
                  key={c.filename}
                  onClick={() => loadCharacter(c.filename)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: isSelected ? 'var(--bg-surface-elevated)' : 'transparent',
                    border: `1px solid ${isSelected ? 'var(--border-prominent)' : 'transparent'}`,
                    textAlign: 'left',
                    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  <FileJson size={16} color={isSelected ? 'var(--accent)' : 'var(--text-muted)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: isSelected ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {c.filename}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* JSON Editor Main Area */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Editor Toolbar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderBottom: '1px solid var(--border-subtle)',
                backgroundColor: 'var(--bg-surface-elevated)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '14px', fontFamily: 'var(--font-mono)' }}>
                  {selectedFile || 'No file selected'}
                </span>
                {jsonError && (
                  <span style={{ fontSize: '11px', color: 'var(--state-error)', backgroundColor: 'var(--state-error-bg)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>
                    JSON Syntax Error
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {selectedFile && (
                  <button
                    onClick={handleDelete}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '6px 12px',
                      backgroundColor: 'rgba(248, 81, 73, 0.1)',
                      color: 'var(--state-error)',
                      border: '1px solid var(--state-error-border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '12px',
                    }}
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                )}

                <button
                  onClick={handleSave}
                  disabled={saving || !!jsonError || !selectedFile}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 16px',
                    backgroundColor: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    borderRadius: 'var(--radius-sm)',
                    fontWeight: 600,
                    fontSize: '12px',
                    opacity: saving || !!jsonError ? 0.6 : 1,
                  }}
                >
                  <Save size={13} />
                  {saving ? 'Saving...' : 'Save Persona'}
                </button>
              </div>
            </div>

            {/* Editor Textarea */}
            <textarea
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder="Select a persona to edit..."
              spellCheck={false}
              style={{
                width: '100%',
                height: '620px',
                padding: '16px',
                backgroundColor: '#050709',
                border: 'none',
                color: '#e6edf3',
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                lineHeight: 1.6,
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Create Character Modal */}
        {showNewModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 200,
              padding: '20px',
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '420px',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--radius-lg)',
                padding: '24px',
                boxShadow: 'var(--shadow-modal)',
              }}
            >
              <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>Create New Persona</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Enter filename for the new persona JSON definition.
              </p>

              <form onSubmit={handleCreateNew} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Filename (e.g. MyBrand.Agent.json)
                  </label>
                  <input
                    type="text"
                    required
                    value={newFilename}
                    onChange={(e) => setNewFilename(e.target.value)}
                    placeholder="Custom.Agent.json"
                    style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                  <button
                    type="button"
                    onClick={() => setShowNewModal(false)}
                    style={{
                      padding: '8px 14px',
                      backgroundColor: 'var(--bg-surface-elevated)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '13px',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    style={{
                      padding: '8px 18px',
                      backgroundColor: 'var(--accent)',
                      color: 'var(--text-inverse)',
                      borderRadius: 'var(--radius-md)',
                      fontWeight: 600,
                      fontSize: '13px',
                    }}
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
