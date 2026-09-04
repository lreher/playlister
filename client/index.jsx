import './index.css';
import { render } from 'preact';
import { App } from './App';
import { SparkleRain } from './components/SparkleRain';
import { applyTheme, getTheme } from './theme';

// Before first paint, so a saved 'classic' choice doesn't flash the
// default studio palette first.
applyTheme(getTheme());

render(
  <>
    <SparkleRain />
    <App />
  </>,
  document.getElementById('root'),
);
