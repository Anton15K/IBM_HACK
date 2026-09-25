/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0B0E14',
        'canvas-dot': '#1A2130',
        panel: '#11151F',
        card: '#161B28',
        line: '#242C3D',
        ink: '#E7EBF4',
        muted: '#8B94A7',
        accent: '#5B8CFF',
        ok: '#34D399',
        warn: '#FBBF24',
        err: '#F87171',
        run: '#60A5FA',
      },
      borderRadius: {
        node: '14px',
        panel: '20px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        node: '0 4px 20px rgba(0,0,0,0.5)',
        panel: '0 8px 40px rgba(0,0,0,0.6)',
      },
      keyframes: {
        pulse_run: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(96,165,250,0.6)' },
          '50%': { boxShadow: '0 0 0 8px rgba(96,165,250,0)' },
        },
      },
      animation: {
        pulse_run: 'pulse_run 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
