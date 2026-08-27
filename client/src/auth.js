/**
 * @fileoverview 認証コンテキスト
 *
 * ログイン中のユーザー情報をアプリ全体で共有します。
 * Providerは App.jsx が提供します。
 *
 * @module auth
 */

import { createContext, useContext } from 'react'

/** 認証情報を保持するReactコンテキスト */
export const AuthContext = createContext(null)

/**
 * 認証情報（user / setUser / loading / logout）を取得します。
 * @returns {{user: Object|null, setUser: Function, loading: boolean, logout: Function}}
 */
export function useAuth() {
  return useContext(AuthContext)
}
