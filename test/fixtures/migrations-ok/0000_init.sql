create table widgets (id serial primary key, name text not null);
--> statement-breakpoint
create index widgets_name_idx on widgets (name);
