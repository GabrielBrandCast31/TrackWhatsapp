import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import PublicForm from './forms/PublicForm'
import './index.css'

// /f/{slug} é o formulário público, no mesmo domínio do painel: abre sem login
// e sem o shell do painel. Todo o resto é o painel.
const formSlug = /^\/f\/([\w-]+)\/?$/.exec(window.location.pathname)?.[1]

createRoot(document.getElementById('root')!).render(
  <StrictMode>{formSlug ? <PublicForm slug={formSlug} /> : <App />}</StrictMode>,
)
