export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      billing_customers: {
        Row: {
          created_at: string
          stripe_customer_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          stripe_customer_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          stripe_customer_id?: string
          user_id?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          featured: boolean
          id: string
          kind: Database["public"]["Enums"]["catalog_kind"]
          nav_order: number
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          featured?: boolean
          id?: string
          kind: Database["public"]["Enums"]["catalog_kind"]
          nav_order?: number
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          featured?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["catalog_kind"]
          nav_order?: number
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      category_translations: {
        Row: {
          category_id: string
          description: string
          locale: Database["public"]["Enums"]["locale_code"]
          seo_description: string
          seo_title: string
          title: string
          updated_at: string
        }
        Insert: {
          category_id: string
          description?: string
          locale: Database["public"]["Enums"]["locale_code"]
          seo_description?: string
          seo_title?: string
          title?: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          description?: string
          locale?: Database["public"]["Enums"]["locale_code"]
          seo_description?: string
          seo_title?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_translations_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      item_translations: {
        Row: {
          body_md: string
          item_id: string
          locale: Database["public"]["Enums"]["locale_code"]
          seo_description: string
          seo_title: string
          slug: string
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          body_md?: string
          item_id: string
          locale: Database["public"]["Enums"]["locale_code"]
          seo_description?: string
          seo_title?: string
          slug: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Update: {
          body_md?: string
          item_id?: string
          locale?: Database["public"]["Enums"]["locale_code"]
          seo_description?: string
          seo_title?: string
          slug?: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_translations_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          category_id: string
          created_at: string
          external_links: Json
          featured: boolean
          id: string
          price_amount: number | null
          price_currency: string
          price_type: Database["public"]["Enums"]["price_type"] | null
          published_at: string | null
          sort_order: number
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          category_id: string
          created_at?: string
          external_links?: Json
          featured?: boolean
          id?: string
          price_amount?: number | null
          price_currency?: string
          price_type?: Database["public"]["Enums"]["price_type"] | null
          published_at?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          category_id?: string
          created_at?: string
          external_links?: Json
          featured?: boolean
          id?: string
          price_amount?: number | null
          price_currency?: string
          price_type?: Database["public"]["Enums"]["price_type"] | null
          published_at?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      media: {
        Row: {
          alt_da: string
          alt_en: string
          created_at: string
          height: number
          id: string
          item_id: string
          mime_type: string
          sort_order: number
          storage_path: string
          width: number
        }
        Insert: {
          alt_da: string
          alt_en?: string
          created_at?: string
          height: number
          id?: string
          item_id: string
          mime_type: string
          sort_order?: number
          storage_path: string
          width: number
        }
        Update: {
          alt_da?: string
          alt_en?: string
          created_at?: string
          height?: number
          id?: string
          item_id?: string
          mime_type?: string
          sort_order?: number
          storage_path?: string
          width?: number
        }
        Relationships: [
          {
            foreignKeyName: "media_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_email_log: {
        Row: {
          id: number
          kind: string
          sent_at: string
          user_id: string
        }
        Insert: {
          id?: never
          kind: string
          sent_at?: string
          user_id: string
        }
        Update: {
          id?: never
          kind?: string
          sent_at?: string
          user_id?: string
        }
        Relationships: []
      }
      monitor_events: {
        Row: {
          detected_at: string
          emailed_at: string | null
          id: string
          monitor_id: string
          new_hash: string | null
          old_hash: string | null
          summary: string | null
          user_id: string
        }
        Insert: {
          detected_at?: string
          emailed_at?: string | null
          id?: string
          monitor_id: string
          new_hash?: string | null
          old_hash?: string | null
          summary?: string | null
          user_id: string
        }
        Update: {
          detected_at?: string
          emailed_at?: string | null
          id?: string
          monitor_id?: string
          new_hash?: string | null
          old_hash?: string | null
          summary?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_events_monitor_owner_fkey"
            columns: ["monitor_id", "user_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      monitor_plan_translations: {
        Row: {
          description: string | null
          locale: Database["public"]["Enums"]["locale_code"]
          name: string
          plan_id: string
        }
        Insert: {
          description?: string | null
          locale: Database["public"]["Enums"]["locale_code"]
          name: string
          plan_id: string
        }
        Update: {
          description?: string | null
          locale?: Database["public"]["Enums"]["locale_code"]
          name?: string
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_plan_translations_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "monitor_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_plans: {
        Row: {
          active: boolean
          amount_ore: number
          billing_interval: string
          created_at: string
          id: string
          monitor_limit: number
          sort_order: number
          stripe_price_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          amount_ore: number
          billing_interval: string
          created_at?: string
          id?: string
          monitor_limit: number
          sort_order?: number
          stripe_price_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          amount_ore?: number
          billing_interval?: string
          created_at?: string
          id?: string
          monitor_limit?: number
          sort_order?: number
          stripe_price_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      monitors: {
        Row: {
          consecutive_errors: number
          created_at: string
          error_notified_at: string | null
          id: string
          interval_minutes: number
          label: string | null
          last_checked_at: string | null
          last_hash: string | null
          last_snapshot: string | null
          status: string
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          consecutive_errors?: number
          created_at?: string
          error_notified_at?: string | null
          id?: string
          interval_minutes: number
          label?: string | null
          last_checked_at?: string | null
          last_hash?: string | null
          last_snapshot?: string | null
          status?: string
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          consecutive_errors?: number
          created_at?: string
          error_notified_at?: string | null
          id?: string
          interval_minutes?: number
          label?: string | null
          last_checked_at?: string | null
          last_hash?: string | null
          last_snapshot?: string | null
          status?: string
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      page_translations: {
        Row: {
          body_md: string
          content: Json
          lead: string
          locale: Database["public"]["Enums"]["locale_code"]
          page_id: string
          seo_description: string
          seo_title: string
          title: string
          updated_at: string
        }
        Insert: {
          body_md?: string
          content?: Json
          lead?: string
          locale: Database["public"]["Enums"]["locale_code"]
          page_id: string
          seo_description?: string
          seo_title?: string
          title?: string
          updated_at?: string
        }
        Update: {
          body_md?: string
          content?: Json
          lead?: string
          locale?: Database["public"]["Enums"]["locale_code"]
          page_id?: string
          seo_description?: string
          seo_title?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_translations_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          created_at: string
          id: string
          nav_order: number
          published_at: string | null
          show_in_nav: boolean
          status: Database["public"]["Enums"]["content_status"]
          system_key: Database["public"]["Enums"]["system_page_key"] | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          nav_order?: number
          published_at?: string | null
          show_in_nav?: boolean
          status?: Database["public"]["Enums"]["content_status"]
          system_key?: Database["public"]["Enums"]["system_page_key"] | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          nav_order?: number
          published_at?: string | null
          show_in_nav?: boolean
          status?: Database["public"]["Enums"]["content_status"]
          system_key?: Database["public"]["Enums"]["system_page_key"] | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          monitor_limit: number | null
          role: Database["public"]["Enums"]["app_role"] | null
          signup_notified_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          monitor_limit?: number | null
          role?: Database["public"]["Enums"]["app_role"] | null
          signup_notified_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          monitor_limit?: number | null
          role?: Database["public"]["Enums"]["app_role"] | null
          signup_notified_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      routes: {
        Row: {
          category_id: string | null
          created_at: string
          locale: Database["public"]["Enums"]["locale_code"]
          page_id: string | null
          slug: string
        }
        Insert: {
          category_id?: string | null
          created_at?: string
          locale: Database["public"]["Enums"]["locale_code"]
          page_id?: string | null
          slug: string
        }
        Update: {
          category_id?: string | null
          created_at?: string
          locale?: Database["public"]["Enums"]["locale_code"]
          page_id?: string | null
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "routes_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routes_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      site_settings: {
        Row: {
          company_name: string
          contact_email: string
          cvr: string | null
          id: boolean
          social_links: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company_name: string
          contact_email: string
          cvr?: string | null
          id?: boolean
          social_links?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company_name?: string
          contact_email?: string
          cvr?: string | null
          id?: boolean
          social_links?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      stripe_events: {
        Row: {
          id: string
          livemode: boolean
          processed_at: string | null
          received_at: string
          type: string
        }
        Insert: {
          id: string
          livemode: boolean
          processed_at?: string | null
          received_at?: string
          type: string
        }
        Update: {
          id?: string
          livemode?: boolean
          processed_at?: string | null
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      subscription_invoices: {
        Row: {
          amount_refunded_ore: number
          amount_tax_ore: number
          amount_total_ore: number
          created_at: string
          email: string
          paid_at: string
          period_end: string | null
          period_start: string | null
          stripe_invoice_id: string
          stripe_subscription_id: string
          user_id: string | null
        }
        Insert: {
          amount_refunded_ore?: number
          amount_tax_ore: number
          amount_total_ore: number
          created_at?: string
          email: string
          paid_at: string
          period_end?: string | null
          period_start?: string | null
          stripe_invoice_id: string
          stripe_subscription_id: string
          user_id?: string | null
        }
        Update: {
          amount_refunded_ore?: number
          amount_tax_ore?: number
          amount_total_ore?: number
          created_at?: string
          email?: string
          paid_at?: string
          period_end?: string | null
          period_start?: string | null
          stripe_invoice_id?: string
          stripe_subscription_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_invoices_stripe_subscription_id_fkey"
            columns: ["stripe_subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["stripe_subscription_id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          last_event_created: string
          plan_id: string
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          last_event_created: string
          plan_id: string
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          last_event_created?: string
          plan_id?: string
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "monitor_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      user_allowlist: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_attach_media: {
        Args: {
          p_alt_da: string
          p_alt_en: string
          p_height: number
          p_item_id: string
          p_path: string
          p_width: number
        }
        Returns: string
      }
      admin_check_media_slot: {
        Args: { p_item_id: string }
        Returns: undefined
      }
      admin_delete_item: { Args: { p_item_id: string }; Returns: string[] }
      admin_delete_monitor_user: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      admin_detach_media: { Args: { p_media_id: string }; Returns: string }
      admin_list_monitor_signups: {
        Args: never
        Returns: {
          confirmed: boolean
          created_at: string
          email: string
          monitor_count: number
          monitors: Json
          user_id: string
        }[]
      }
      admin_list_orphan_media: {
        Args: { p_older_than?: string }
        Returns: string[]
      }
      admin_reorder_items: {
        Args: { p_category_id: string; p_item_ids: string[] }
        Returns: undefined
      }
      admin_reorder_nav: { Args: { p_page_ids: string[] }; Returns: undefined }
      admin_save_category: { Args: { payload: Json }; Returns: string }
      admin_save_item: { Args: { payload: Json }; Returns: string }
      admin_save_page: { Args: { payload: Json }; Returns: string }
      admin_set_category_status: {
        Args: {
          p_category_id: string
          p_status: Database["public"]["Enums"]["content_status"]
        }
        Returns: undefined
      }
      admin_set_item_status: {
        Args: {
          p_item_id: string
          p_status: Database["public"]["Enums"]["content_status"]
        }
        Returns: undefined
      }
      admin_set_page_nav: {
        Args: { p_page_id: string; p_show: boolean }
        Returns: undefined
      }
      admin_set_page_status: {
        Args: {
          p_page_id: string
          p_status: Database["public"]["Enums"]["content_status"]
        }
        Returns: undefined
      }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
      monitor_engine_claim: {
        Args: {
          p_error_threshold: number
          p_grace_minutes: number
          p_limit: number
        }
        Returns: {
          consecutive_errors: number
          id: string
          last_hash: string
          prior_strikes: number
          url: string
          user_id: string
        }[]
      }
      monitor_engine_mark_emailed: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      monitor_engine_mark_signup_notified: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      monitor_engine_pending_emails: {
        Args: { p_daily_cap: number; p_limit: number }
        Returns: {
          detected_at: string
          email: string
          event_id: string
          label: string
          monitor_id: string
          summary: string
          url: string
          user_id: string
        }[]
      }
      monitor_engine_pending_signups: {
        Args: { p_daily_cap: number; p_limit: number }
        Returns: {
          confirmed_at: string
          email: string
          owner_emails: string[]
          user_id: string
          waiting: number
        }[]
      }
      monitor_engine_purge_unconfirmed: {
        Args: { p_limit: number }
        Returns: number
      }
      monitor_engine_record: {
        Args: {
          p_claimed_url: string
          p_daily_cap?: number
          p_error_threshold?: number
          p_expected_hash?: string
          p_monitor_id: string
          p_new_hash?: string
          p_outcome: string
          p_repay?: boolean
          p_snapshot?: string
          p_summary?: string
        }
        Returns: {
          applied: boolean
          consecutive_errors: number
          email: string
          event_id: string
          label: string
          notified_at: string
          notify_error: boolean
          url: string
        }[]
      }
      monitor_engine_snapshot: {
        Args: { p_monitor_id: string }
        Returns: string
      }
      my_monitor_limit: { Args: never; Returns: number }
      payments_record_subscription_invoice: {
        Args: { p_event: Json; p_invoice: Json; p_subscription: Json }
        Returns: Json
      }
      payments_sync_subscription: {
        Args: { p_event: Json; p_subscription: Json }
        Returns: Json
      }
    }
    Enums: {
      app_role: "owner" | "admin" | "mylife_user" | "monitor_user"
      catalog_kind: "apps" | "websites" | "services" | "models3d"
      content_status: "draft" | "published"
      locale_code: "da" | "en"
      price_type: "fixed" | "from" | "contact"
      system_page_key: "home" | "contact" | "privacy" | "monitor"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "admin", "mylife_user", "monitor_user"],
      catalog_kind: ["apps", "websites", "services", "models3d"],
      content_status: ["draft", "published"],
      locale_code: ["da", "en"],
      price_type: ["fixed", "from", "contact"],
      system_page_key: ["home", "contact", "privacy", "monitor"],
    },
  },
} as const
