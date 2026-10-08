import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Cpu, Briefcase, Users, Plus, LogOut, Terminal } from 'lucide-react';

export const Navbar: React.FC = () => {
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      navigate('/login');
    }
  };

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        height: '60px',
        backgroundColor: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <NavLink
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            textDecoration: 'none',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#080a0d',
              fontWeight: 700,
            }}
          >
            <Cpu size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.05em' }}>
              INSTAGRAM <span style={{ color: 'var(--accent)', fontSize: '11px' }}>AI AGENT CONTROL ROOM</span>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              AUTONOMOUS INSTAGRAM & JOB AGENTS
            </div>
          </div>
        </NavLink>

        {/* Primary Nav */}
        <nav style={{ display: 'flex', gap: '4px', marginLeft: '20px' }}>
          <NavLink
            to="/"
            end
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 500,
              backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'var(--border-subtle)' : 'transparent'}`,
            })}
          >
            <Cpu size={14} />
            Instagram Bots
          </NavLink>

          <NavLink
            to="/jobbot"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 500,
              backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'var(--border-subtle)' : 'transparent'}`,
            })}
          >
            <Briefcase size={14} />
            Job Bot
          </NavLink>

          <NavLink
            to="/characters"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 500,
              backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'var(--border-subtle)' : 'transparent'}`,
            })}
          >
            <Users size={14} />
            Personas
          </NavLink>

          <NavLink
            to="/logs"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 500,
              backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'var(--border-subtle)' : 'transparent'}`,
            })}
          >
            <Terminal size={14} />
            System Logs
          </NavLink>
        </nav>
      </div>

      {/* Right Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={() => navigate('/accounts/new')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            backgroundColor: 'var(--accent)',
            color: 'var(--text-inverse)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
            fontSize: '13px',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent)')}
        >
          <Plus size={14} strokeWidth={2.5} />
          New Bot
        </button>

        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            backgroundColor: 'var(--bg-surface-elevated)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            fontSize: '13px',
          }}
          title="Sign out"
        >
          <LogOut size={14} />
          Exit
        </button>
      </div>
    </header>
  );
};
