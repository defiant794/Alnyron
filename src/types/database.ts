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
          role: Database["public"]["Enums"]["app_role"] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          role?: Database["public"]["Enums"]["app_role"] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          role?: Database["public"]["Enums"]["app_role"] | null
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
      admin_detach_media: { Args: { p_media_id: string }; Returns: string }
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
      admin_set_page_status: {
        Args: {
          p_page_id: string
          p_status: Database["public"]["Enums"]["content_status"]
        }
        Returns: undefined
      }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
    }
    Enums: {
      app_role: "owner" | "admin" | "mylife_user"
      catalog_kind: "apps" | "websites" | "services" | "models3d"
      content_status: "draft" | "published"
      locale_code: "da" | "en"
      price_type: "fixed" | "from" | "contact"
      system_page_key: "home" | "contact" | "privacy"
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
      app_role: ["owner", "admin", "mylife_user"],
      catalog_kind: ["apps", "websites", "services", "models3d"],
      content_status: ["draft", "published"],
      locale_code: ["da", "en"],
      price_type: ["fixed", "from", "contact"],
      system_page_key: ["home", "contact", "privacy"],
    },
  },
} as const
