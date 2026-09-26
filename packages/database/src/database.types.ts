export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      aircraft: {
        Row: {
          country: string | null;
          created_at: string;
          family: string | null;
          icao_type_code: string | null;
          icao24: string;
          id: string;
          manufacturer: string | null;
          metadata_source: string | null;
          model: string | null;
          operator_iata: string | null;
          operator_icao: string | null;
          operator_name: string | null;
          raw_metadata: Json;
          registration: string | null;
          updated_at: string;
          variant: string | null;
        };
        Insert: {
          country?: string | null;
          created_at?: string;
          family?: string | null;
          icao_type_code?: string | null;
          icao24: string;
          id?: string;
          manufacturer?: string | null;
          metadata_source?: string | null;
          model?: string | null;
          operator_iata?: string | null;
          operator_icao?: string | null;
          operator_name?: string | null;
          raw_metadata?: Json;
          registration?: string | null;
          updated_at?: string;
          variant?: string | null;
        };
        Update: {
          country?: string | null;
          created_at?: string;
          family?: string | null;
          icao_type_code?: string | null;
          icao24?: string;
          id?: string;
          manufacturer?: string | null;
          metadata_source?: string | null;
          model?: string | null;
          operator_iata?: string | null;
          operator_icao?: string | null;
          operator_name?: string | null;
          raw_metadata?: Json;
          registration?: string | null;
          updated_at?: string;
          variant?: string | null;
        };
        Relationships: [];
      };
      aircraft_types: {
        Row: {
          aircraft_class: string | null;
          created_at: string;
          engine_count: number | null;
          engine_type: string | null;
          icao_type_code: string;
          manufacturer: string | null;
          model: string | null;
          name: string;
          source: string;
          updated_at: string;
          wake_category: string | null;
        };
        Insert: {
          aircraft_class?: string | null;
          created_at?: string;
          engine_count?: number | null;
          engine_type?: string | null;
          icao_type_code: string;
          manufacturer?: string | null;
          model?: string | null;
          name: string;
          source?: string;
          updated_at?: string;
          wake_category?: string | null;
        };
        Update: {
          aircraft_class?: string | null;
          created_at?: string;
          engine_count?: number | null;
          engine_type?: string | null;
          icao_type_code?: string;
          manufacturer?: string | null;
          model?: string | null;
          name?: string;
          source?: string;
          updated_at?: string;
          wake_category?: string | null;
        };
        Relationships: [];
      };
      art_assets: {
        Row: {
          aircraft_id: string | null;
          approved_at: string | null;
          created_at: string;
          generation_model: string | null;
          generation_prompt: string | null;
          generation_provider: string | null;
          icao_type_code: string | null;
          id: string;
          identity_confidence: number | null;
          livery_name: string | null;
          operator_icao: string | null;
          owner_id: string;
          prompt_version: string | null;
          registration: string | null;
          reviewer_notes: string | null;
          scope: string;
          source_image_id: string | null;
          status: string;
          storage_path: string;
          thumbnail_path: string | null;
          updated_at: string;
        };
        Insert: {
          aircraft_id?: string | null;
          approved_at?: string | null;
          created_at?: string;
          generation_model?: string | null;
          generation_prompt?: string | null;
          generation_provider?: string | null;
          icao_type_code?: string | null;
          id?: string;
          identity_confidence?: number | null;
          livery_name?: string | null;
          operator_icao?: string | null;
          owner_id?: string;
          prompt_version?: string | null;
          registration?: string | null;
          reviewer_notes?: string | null;
          scope: string;
          source_image_id?: string | null;
          status?: string;
          storage_path: string;
          thumbnail_path?: string | null;
          updated_at?: string;
        };
        Update: {
          aircraft_id?: string | null;
          approved_at?: string | null;
          created_at?: string;
          generation_model?: string | null;
          generation_prompt?: string | null;
          generation_provider?: string | null;
          icao_type_code?: string | null;
          id?: string;
          identity_confidence?: number | null;
          livery_name?: string | null;
          operator_icao?: string | null;
          owner_id?: string;
          prompt_version?: string | null;
          registration?: string | null;
          reviewer_notes?: string | null;
          scope?: string;
          source_image_id?: string | null;
          status?: string;
          storage_path?: string;
          thumbnail_path?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'art_assets_aircraft_id_fkey';
            columns: ['aircraft_id'];
            isOneToOne: false;
            referencedRelation: 'aircraft';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'art_assets_source_image_fk';
            columns: ['owner_id', 'source_image_id'];
            isOneToOne: false;
            referencedRelation: 'source_images';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      device_display_settings: {
        Row: {
          airline_only: boolean;
          created_at: string;
          device_id: string;
          include_helicopters: boolean;
          include_near_misses: boolean;
          max_planes: number;
          min_dwell_minutes: number;
          one_per_operator_type: boolean;
          owner_id: string;
          quiet_end_hour: number | null;
          quiet_start_hour: number | null;
          updated_at: string;
          weight_artwork: number;
          weight_detail: number;
          weight_proximity: number;
          weight_rarity: number;
          weight_recency: number;
          window_hours: number;
        };
        Insert: {
          airline_only?: boolean;
          created_at?: string;
          device_id: string;
          include_helicopters?: boolean;
          include_near_misses?: boolean;
          max_planes?: number;
          min_dwell_minutes?: number;
          one_per_operator_type?: boolean;
          owner_id: string;
          quiet_end_hour?: number | null;
          quiet_start_hour?: number | null;
          updated_at?: string;
          weight_artwork?: number;
          weight_detail?: number;
          weight_proximity?: number;
          weight_rarity?: number;
          weight_recency?: number;
          window_hours?: number;
        };
        Update: {
          airline_only?: boolean;
          created_at?: string;
          device_id?: string;
          include_helicopters?: boolean;
          include_near_misses?: boolean;
          max_planes?: number;
          min_dwell_minutes?: number;
          one_per_operator_type?: boolean;
          owner_id?: string;
          quiet_end_hour?: number | null;
          quiet_start_hour?: number | null;
          updated_at?: string;
          weight_artwork?: number;
          weight_detail?: number;
          weight_proximity?: number;
          weight_rarity?: number;
          weight_recency?: number;
          window_hours?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'device_display_settings_device_fk';
            columns: ['owner_id', 'device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      devices: {
        Row: {
          battery_mv: number | null;
          created_at: string;
          device_ref: string;
          firmware_version: string | null;
          hardware_revision: string | null;
          id: string;
          last_boot_reason: string | null;
          last_seen_at: string | null;
          latest_poster_id: string | null;
          location_id: string | null;
          mac_address: string;
          name: string;
          owner_id: string;
          poll_interval_seconds: number;
          reset_requested: boolean;
          rssi: number | null;
          updated_at: string;
        };
        Insert: {
          battery_mv?: number | null;
          created_at?: string;
          device_ref?: string;
          firmware_version?: string | null;
          hardware_revision?: string | null;
          id?: string;
          last_boot_reason?: string | null;
          last_seen_at?: string | null;
          latest_poster_id?: string | null;
          location_id?: string | null;
          mac_address: string;
          name: string;
          owner_id?: string;
          poll_interval_seconds?: number;
          reset_requested?: boolean;
          rssi?: number | null;
          updated_at?: string;
        };
        Update: {
          battery_mv?: number | null;
          created_at?: string;
          device_ref?: string;
          firmware_version?: string | null;
          hardware_revision?: string | null;
          id?: string;
          last_boot_reason?: string | null;
          last_seen_at?: string | null;
          latest_poster_id?: string | null;
          location_id?: string | null;
          mac_address?: string;
          name?: string;
          owner_id?: string;
          poll_interval_seconds?: number;
          reset_requested?: boolean;
          rssi?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'devices_latest_poster_fk';
            columns: ['owner_id', 'latest_poster_id'];
            isOneToOne: false;
            referencedRelation: 'posters';
            referencedColumns: ['owner_id', 'id'];
          },
          {
            foreignKeyName: 'devices_location_fk';
            columns: ['owner_id', 'location_id'];
            isOneToOne: false;
            referencedRelation: 'locations';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      display_selections: {
        Row: {
          created_at: string;
          device_id: string;
          id: string;
          items: Json;
          overflight_ids: string[];
          owner_id: string;
          reason: string;
          selected_at: string;
          settings: Json;
        };
        Insert: {
          created_at?: string;
          device_id: string;
          id?: string;
          items: Json;
          overflight_ids: string[];
          owner_id: string;
          reason: string;
          selected_at: string;
          settings?: Json;
        };
        Update: {
          created_at?: string;
          device_id?: string;
          id?: string;
          items?: Json;
          overflight_ids?: string[];
          owner_id?: string;
          reason?: string;
          selected_at?: string;
          settings?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'display_selections_device_fk';
            columns: ['owner_id', 'device_id'];
            isOneToOne: false;
            referencedRelation: 'devices';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      image_cutouts: {
        Row: {
          attempts: number;
          created_at: string;
          error: string | null;
          id: string;
          owner_id: string;
          processed_at: string | null;
          provider: string | null;
          requested_at: string;
          source_image_id: string;
          status: string;
          storage_path: string | null;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          error?: string | null;
          id?: string;
          owner_id: string;
          processed_at?: string | null;
          provider?: string | null;
          requested_at?: string;
          source_image_id: string;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          error?: string | null;
          id?: string;
          owner_id?: string;
          processed_at?: string | null;
          provider?: string | null;
          requested_at?: string;
          source_image_id?: string;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'image_cutouts_source_image_fk';
            columns: ['owner_id', 'source_image_id'];
            isOneToOne: false;
            referencedRelation: 'source_images';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      locations: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          latitude: number;
          longitude: number;
          max_altitude_ft: number;
          name: string;
          overhead_radius_m: number;
          owner_id: string;
          search_radius_nm: number;
          timezone: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          latitude: number;
          longitude: number;
          max_altitude_ft?: number;
          name: string;
          overhead_radius_m?: number;
          owner_id?: string;
          search_radius_nm?: number;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          latitude?: number;
          longitude?: number;
          max_altitude_ft?: number;
          name?: string;
          overhead_radius_m?: number;
          owner_id?: string;
          search_radius_nm?: number;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      overflight_points: {
        Row: {
          altitude_ft: number | null;
          created_at: string;
          groundspeed_knots: number | null;
          id: number;
          latitude: number;
          longitude: number;
          observed_at: string;
          overflight_id: string;
          source: string;
          track_degrees: number | null;
        };
        Insert: {
          altitude_ft?: number | null;
          created_at?: string;
          groundspeed_knots?: number | null;
          id?: never;
          latitude: number;
          longitude: number;
          observed_at: string;
          overflight_id: string;
          source?: string;
          track_degrees?: number | null;
        };
        Update: {
          altitude_ft?: number | null;
          created_at?: string;
          groundspeed_knots?: number | null;
          id?: never;
          latitude?: number;
          longitude?: number;
          observed_at?: string;
          overflight_id?: string;
          source?: string;
          track_degrees?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'overflight_points_overflight_id_fkey';
            columns: ['overflight_id'];
            isOneToOne: false;
            referencedRelation: 'overflights';
            referencedColumns: ['id'];
          },
        ];
      };
      overflights: {
        Row: {
          aircraft_id: string | null;
          callsign: string | null;
          closest_altitude_ft: number | null;
          closest_latitude: number | null;
          closest_longitude: number | null;
          closest_seen_at: string;
          created_at: string;
          destination_code: string | null;
          first_seen_at: string;
          flight_number: string | null;
          heading: number | null;
          icao24: string;
          id: string;
          last_seen_at: string;
          local_date: string;
          location_id: string;
          minimum_altitude_ft: number | null;
          minimum_distance_m: number;
          origin_code: string | null;
          owner_id: string;
          provider: string;
          provider_pass_key: string;
          qualification_reason: string;
          raw_summary: Json;
          registration: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          aircraft_id?: string | null;
          callsign?: string | null;
          closest_altitude_ft?: number | null;
          closest_latitude?: number | null;
          closest_longitude?: number | null;
          closest_seen_at: string;
          created_at?: string;
          destination_code?: string | null;
          first_seen_at: string;
          flight_number?: string | null;
          heading?: number | null;
          icao24: string;
          id?: string;
          last_seen_at: string;
          local_date: string;
          location_id: string;
          minimum_altitude_ft?: number | null;
          minimum_distance_m: number;
          origin_code?: string | null;
          owner_id: string;
          provider: string;
          provider_pass_key: string;
          qualification_reason: string;
          raw_summary?: Json;
          registration?: string | null;
          status: string;
          updated_at?: string;
        };
        Update: {
          aircraft_id?: string | null;
          callsign?: string | null;
          closest_altitude_ft?: number | null;
          closest_latitude?: number | null;
          closest_longitude?: number | null;
          closest_seen_at?: string;
          created_at?: string;
          destination_code?: string | null;
          first_seen_at?: string;
          flight_number?: string | null;
          heading?: number | null;
          icao24?: string;
          id?: string;
          last_seen_at?: string;
          local_date?: string;
          location_id?: string;
          minimum_altitude_ft?: number | null;
          minimum_distance_m?: number;
          origin_code?: string | null;
          owner_id?: string;
          provider?: string;
          provider_pass_key?: string;
          qualification_reason?: string;
          raw_summary?: Json;
          registration?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'overflights_aircraft_id_fkey';
            columns: ['aircraft_id'];
            isOneToOne: false;
            referencedRelation: 'aircraft';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'overflights_location_fk';
            columns: ['owner_id', 'location_id'];
            isOneToOne: false;
            referencedRelation: 'locations';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      photo_collection: {
        Row: {
          created_at: string;
          icao_type_code: string;
          id: string;
          operator_icao: string | null;
          owner_id: string;
          source_image_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          icao_type_code: string;
          id?: string;
          operator_icao?: string | null;
          owner_id: string;
          source_image_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          icao_type_code?: string;
          id?: string;
          operator_icao?: string | null;
          owner_id?: string;
          source_image_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'photo_collection_source_image_fk';
            columns: ['owner_id', 'source_image_id'];
            isOneToOne: false;
            referencedRelation: 'source_images';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      poster_items: {
        Row: {
          art_asset_id: string | null;
          created_at: string;
          display_order: number;
          id: string;
          overflight_id: string;
          owner_id: string;
          poster_id: string;
          rendered_labels: Json;
          updated_at: string;
        };
        Insert: {
          art_asset_id?: string | null;
          created_at?: string;
          display_order: number;
          id?: string;
          overflight_id: string;
          owner_id?: string;
          poster_id: string;
          rendered_labels?: Json;
          updated_at?: string;
        };
        Update: {
          art_asset_id?: string | null;
          created_at?: string;
          display_order?: number;
          id?: string;
          overflight_id?: string;
          owner_id?: string;
          poster_id?: string;
          rendered_labels?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'poster_items_art_asset_fk';
            columns: ['owner_id', 'art_asset_id'];
            isOneToOne: false;
            referencedRelation: 'art_assets';
            referencedColumns: ['owner_id', 'id'];
          },
          {
            foreignKeyName: 'poster_items_overflight_fk';
            columns: ['owner_id', 'overflight_id'];
            isOneToOne: false;
            referencedRelation: 'overflights';
            referencedColumns: ['owner_id', 'id'];
          },
          {
            foreignKeyName: 'poster_items_poster_fk';
            columns: ['owner_id', 'poster_id'];
            isOneToOne: false;
            referencedRelation: 'posters';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      posters: {
        Row: {
          binary_sha256: string | null;
          created_at: string;
          device_binary_path: string | null;
          eink_preview_path: string | null;
          error: string | null;
          full_color_preview_path: string | null;
          generated_at: string | null;
          height: number;
          id: string;
          local_date: string;
          location_id: string;
          owner_id: string;
          status: string;
          template_version: string;
          updated_at: string;
          width: number;
        };
        Insert: {
          binary_sha256?: string | null;
          created_at?: string;
          device_binary_path?: string | null;
          eink_preview_path?: string | null;
          error?: string | null;
          full_color_preview_path?: string | null;
          generated_at?: string | null;
          height?: number;
          id?: string;
          local_date: string;
          location_id: string;
          owner_id?: string;
          status?: string;
          template_version: string;
          updated_at?: string;
          width?: number;
        };
        Update: {
          binary_sha256?: string | null;
          created_at?: string;
          device_binary_path?: string | null;
          eink_preview_path?: string | null;
          error?: string | null;
          full_color_preview_path?: string | null;
          generated_at?: string | null;
          height?: number;
          id?: string;
          local_date?: string;
          location_id?: string;
          owner_id?: string;
          status?: string;
          template_version?: string;
          updated_at?: string;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'posters_location_fk';
            columns: ['owner_id', 'location_id'];
            isOneToOne: false;
            referencedRelation: 'locations';
            referencedColumns: ['owner_id', 'id'];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string | null;
          id: string;
          timezone: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string | null;
          id: string;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          id?: string;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      source_images: {
        Row: {
          aircraft_id: string | null;
          attribution_text: string | null;
          created_at: string;
          creator: string | null;
          id: string;
          identity_confidence: number | null;
          license_name: string | null;
          license_url: string | null;
          original_file_url: string | null;
          owner_id: string;
          raw_metadata: Json;
          source_page_url: string | null;
          source_provider: string;
          storage_path: string | null;
          updated_at: string;
          view_angle_score: number | null;
        };
        Insert: {
          aircraft_id?: string | null;
          attribution_text?: string | null;
          created_at?: string;
          creator?: string | null;
          id?: string;
          identity_confidence?: number | null;
          license_name?: string | null;
          license_url?: string | null;
          original_file_url?: string | null;
          owner_id?: string;
          raw_metadata?: Json;
          source_page_url?: string | null;
          source_provider: string;
          storage_path?: string | null;
          updated_at?: string;
          view_angle_score?: number | null;
        };
        Update: {
          aircraft_id?: string | null;
          attribution_text?: string | null;
          created_at?: string;
          creator?: string | null;
          id?: string;
          identity_confidence?: number | null;
          license_name?: string | null;
          license_url?: string | null;
          original_file_url?: string | null;
          owner_id?: string;
          raw_metadata?: Json;
          source_page_url?: string | null;
          source_provider?: string;
          storage_path?: string | null;
          updated_at?: string;
          view_angle_score?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'source_images_aircraft_id_fkey';
            columns: ['aircraft_id'];
            isOneToOne: false;
            referencedRelation: 'aircraft';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      hangar_aircraft: {
        Row: {
          aircraft_id: string | null;
          best_art_asset_id: string | null;
          best_art_scope: string | null;
          closest_distance_m: number | null;
          closest_overflight_id: string | null;
          first_seen_at: string | null;
          has_artwork: boolean | null;
          icao_type_code: string | null;
          icao24: string | null;
          last_seen_at: string | null;
          lowest_altitude_ft: number | null;
          manufacturer: string | null;
          model: string | null;
          operator_icao: string | null;
          operator_name: string | null;
          owner_id: string | null;
          pass_count: number | null;
          qualified_pass_count: number | null;
          registration: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'overflights_aircraft_id_fkey';
            columns: ['aircraft_id'];
            isOneToOne: false;
            referencedRelation: 'aircraft';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
